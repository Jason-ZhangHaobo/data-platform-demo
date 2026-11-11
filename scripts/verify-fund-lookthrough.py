"""Run the synthetic fund look-through benchmark with local Spark."""

import argparse
from collections import defaultdict
from copy import deepcopy
from decimal import Decimal
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "fixtures/fund-lookthrough"
COLUMNS = {
    "portfolios": ("portfolio_id", "manager_id"),
    "fund_positions": ("position_id", "portfolio_id", "fund_code", "trade_date", "market_value", "currency"),
    "fund_allocations": ("fund_code", "trade_date", "underlying_id", "asset_class", "allocation_weight"),
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def unique_rows(rows, key, error):
    unique = {}
    for row in rows:
        identity = key(row)
        require(identity not in unique or unique[identity] == row, error)
        unique[identity] = row
    return unique.values()


def validate_inputs(case):
    require(case["classification"] == "SYNTHETIC", "SYNTHETIC_FIXTURE_REQUIRED")
    tables = case["tables"]
    require(set(tables) == set(COLUMNS), "UNEXPECTED_SOURCE_TABLES")
    for table, columns in COLUMNS.items():
        require(all(len(row) == len(columns) for row in tables[table]), "INPUT_SCHEMA_MISMATCH")
    portfolios = unique_rows(tables["portfolios"], lambda row: row[0], "CONFLICTING_PORTFOLIO_MANAGER")
    portfolio_ids = {row[0] for row in portfolios}
    for row in tables["fund_positions"]:
        require(row[1] in portfolio_ids and row[5] == "CNY" and re.fullmatch(r"\d{1,16}\.\d{2}", row[4]),
                "INVALID_CNY_POSITION")
    positions = unique_rows(tables["fund_positions"], lambda row: (row[1], row[3], row[0]), "CONFLICTING_POSITION")
    for row in tables["fund_allocations"]:
        require(row[3] in {"股票", "债券", "现金"} and re.fullmatch(r"[01]\.\d{6}", row[4]), "INVALID_ALLOCATION")
    allocations = unique_rows(tables["fund_allocations"], lambda row: tuple(row[:3]), "CONFLICTING_ALLOCATION")
    weight_by_date = defaultdict(Decimal)
    for fund, day, _, _, weight in allocations:
        weight_by_date[fund, day] += Decimal(weight)
    require(all(weight <= 1 for weight in weight_by_date.values()), "ALLOCATION_ABOVE_ONE")

    owned = {portfolio for portfolio, manager in portfolios if manager == case["managerId"]}
    totals = defaultdict(Decimal)
    for _, portfolio, _, day, value, _ in positions:
        if portfolio in owned and day == case["businessDate"]:
            totals[portfolio] += Decimal(value)
    return dict(totals)


def assert_output(rows, expected, totals):
    require(rows == expected, "FUND_LOOKTHROUGH_ROWS_MISMATCH")
    actual_totals = defaultdict(Decimal)
    for row in rows:
        actual_totals[row["portfolio_id"]] += Decimal(row["exposure_amount"])
    require(dict(actual_totals) == totals, "FUND_LOOKTHROUGH_TOTALS_MISMATCH")


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
    sys.path.insert(0, str(ROOT / "src/v2"))
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
    context = {"advisorId": case["managerId"], "businessDate": case["businessDate"],
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
