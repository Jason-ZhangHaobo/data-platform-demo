"""Run the synthetic fund look-through benchmark with local Spark."""

import argparse
from copy import deepcopy
from decimal import Decimal
from hashlib import sha256
import json
import os
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "fixtures/fund-lookthrough"
sys.path.insert(0, str(ROOT / "src/v2"))
from fund_lookthrough import COLUMNS, assert_output, require, validate_inputs


def require_failure(operation, code):
    try:
        operation()
    except ValueError as error:
        require(str(error) == code, f"EXPECTED_{code}")
    else:
        raise ValueError(f"EXPECTED_{code}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", required=True, type=Path)
    output_dir = parser.parse_args().output_dir.resolve(strict=True)
    require(output_dir.is_dir() and output_dir.stat().st_mode & 0o777 == 0o700, "PROTECTED_OUTPUT_DIRECTORY_REQUIRED")
    output = output_dir / "fund-lookthrough-acceptance.json"
    require(not output.exists(), "REFUSE_TO_OVERWRITE_RECEIPT")
    os.environ.setdefault("JAVA_HOME", str(ROOT / ".runtime/java/Contents/Home"))
    os.environ["SPARK_LOCAL_IP"] = "127.0.0.1"
    os.environ["PYSPARK_PYTHON"] = sys.executable
    os.chdir(output_dir)
    from worker import create_spark, validate_sql

    fixture = (FIXTURES / "case.json").read_bytes()
    query = (FIXTURES / "reference.sql").read_bytes()
    case = json.loads(fixture)
    sql = query.decode()
    totals = validate_inputs(case)
    conflict = deepcopy(case)
    conflict["tables"]["fund_positions"][1][4] = "1001.00"
    require_failure(lambda: validate_inputs(conflict), "CONFLICTING_POSITION")
    overweight = deepcopy(case)
    overweight["tables"]["fund_allocations"][4][4] = "0.600000"
    require_failure(lambda: validate_inputs(overweight), "ALLOCATION_ABOVE_ONE")
    context = {"id": case["id"], "managerId": case["managerId"], "businessDate": case["businessDate"],
               "tables": [{"name": name} for name in COLUMNS]}

    def run(statement):
        frame = spark.sql(validate_sql(statement, context))
        return [{key: format(value, "f") if isinstance(value, Decimal) else value
                 for key, value in row.asDict().items()} for row in frame.collect()]

    started = time.monotonic()
    spark = create_spark()
    try:
        spark.sparkContext.setLogLevel("ERROR")
        for name, columns in COLUMNS.items():
            spark.createDataFrame(case["tables"][name], list(columns)).createOrReplaceTempView(name)
        actual = run(sql)
        assert_output(actual, case["expected"], totals)
        date_filter = "WHERE trade_date = '{{trade_date}}'"
        require(sql.count(date_filter) == 1, "NEGATIVE_FIXTURE_FILTER_MISSING")
        stale = run(sql.replace(date_filter, "WHERE trade_date <= '{{trade_date}}'"))
        require_failure(lambda: assert_output(stale, case["expected"], totals), "FUND_LOOKTHROUGH_ROWS_MISMATCH")
        version = spark.version
    finally:
        spark.stop()
    result = {"status": "PASSED", "scope": "LOCAL_SYNTHETIC_FUND_LOOKTHROUGH_BENCHMARK",
              "caseId": case["id"], "engine": "Apache Spark", "engineVersion": version,
              "fixtureSha256": sha256(fixture).hexdigest(), "sqlSha256": sha256(query).hexdigest(),
              "portfolioTotalsCny": {key: format(value, "f") for key, value in totals.items()},
              "rows": actual, "staleAllocationQueryRejected": True,
              "inputRejectedBeforeSpark": ["CONFLICTING_POSITION", "ALLOCATION_ABOVE_ONE"],
              "modelCalls": 0, "cloudRequests": 0, "durationMs": round((time.monotonic() - started) * 1000)}
    with output.open("x", encoding="utf8") as handle:
        os.chmod(output, 0o600)
        json.dump(result, handle, ensure_ascii=False, indent=2)
    print(json.dumps({"status": result["status"], "engineVersion": version, "rows": len(actual),
                      "portfolios": len(totals), "durationMs": result["durationMs"]}))


if __name__ == "__main__":
    main()
