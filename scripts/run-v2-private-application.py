#!/usr/bin/env python3
"""Run a private application fixture or reread its persisted task via FC CLI."""
import argparse
import hashlib
import json
import re
import subprocess


def invoke(payload):
    result = subprocess.run([
        "aliyun", "fc", "POST",
        "/2023-03-30/functions/dataplatform-v2-staging-api/invocations",
        "--region", "cn-hangzhou", "--read-timeout", "240",
        "--connect-timeout", "10", "--retry-count", "0",
        "--header", "Content-Type=application/octet-stream",
        "--body", json.dumps(payload),
    ], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        universal_newlines=True, timeout=270)
    if result.returncode:
        raise ValueError("PRIVATE_APPLICATION_INVOKE_FAILED")
    body = json.loads(result.stdout)
    if isinstance(body, str):
        body = json.loads(body)
    return body


def digest(rows):
    return hashlib.sha256(json.dumps(rows, sort_keys=True).encode()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case", choices=["holdings-t1", "cash-change"])
    parser.add_argument("--output")
    parser.add_argument("--restore-from")
    parser.add_argument("--submit-only", action="store_true")
    args = parser.parse_args()
    if args.restore_from:
        with open(args.restore_from) as source:
            original = json.load(source)
        run_id = original.get("runId", "")
        if not re.match(r"^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$", run_id):
            raise ValueError("PRIVATE_APPLICATION_RUN_ID_INVALID")
        response = invoke({"operation": "PRIVATE_APPLICATION_HTTP_V1",
                           "method": "GET", "path": "/api/v2/runs/" + run_id})
        restored = response.get("body", {})
        expected = "2300.00" if original.get("caseId") == "cash-change" else "1800.00"
        observed = next((str(row.get("total_assets")) for row in restored.get("rows", []) if row.get("client_id") == "CLIENT-001"), None)
        passed = (response.get("status") == 200 and
                  restored.get("status") == "SUCCEEDED" and
                  restored.get("engineVersion") == "3.5.9" and restored.get("mainSqlExecuted") is True and
                  restored.get("validation", {}).get("passed") is True and observed == expected and
                  ("rows" not in original or restored.get("rows") == original["rows"]) and
                  restored.get("revisionHash") == original["revisionHash"])
        summary = {"runId": run_id, "restoredResultMatches": passed,
                   "status": restored.get("status"), "totalAssets": observed,
                   "regressionCount": len(restored.get("validation", {}).get("regressions", [])),
                   "rowsHash": digest(restored.get("rows", []))}
        print(json.dumps(summary, sort_keys=True))
        if not passed:
            raise ValueError("PRIVATE_APPLICATION_RESTORE_FAILED")
        return
    if not args.case or not args.output:
        parser.error("provide --case and --output, or --restore-from")
    report = invoke({"operation": "PRIVATE_APPLICATION_TASK_V1", "caseId": args.case, "submitOnly": args.submit_only})
    if args.submit_only:
        if report.get("protocol") != "shuduo-private-application-submission/v1" or report.get("status") != "SUBMITTED":
            raise ValueError("PRIVATE_APPLICATION_SUBMISSION_FAILED")
        with open(args.output, "w") as target:
            json.dump(report, target, indent=2, sort_keys=True)
        print(json.dumps(report, sort_keys=True))
        return
    expected = "2300.00" if args.case == "cash-change" else "1800.00"
    if (report.get("protocol") != "shuduo-private-application-acceptance/v1" or
            report.get("status") != "SUCCEEDED" or
            report.get("engineVersion") != "3.5.9" or
            report.get("totalAssets") != expected or
            report.get("assertionsPassed") is not True or
            report.get("duplicateSubmissionDeduplicated") is not True or
            report.get("refreshedResultMatches") is not True):
        code = report.get("code", "PRIVATE_APPLICATION_ACCEPTANCE_FAILED")
        raise ValueError(code if re.match(r"^[A-Z0-9_]+$", str(code)) else "PRIVATE_APPLICATION_ACCEPTANCE_FAILED")
    with open(args.output, "w") as target:
        json.dump(report, target, indent=2, sort_keys=True)
    summary = {key: report[key] for key in ["caseId", "runId", "revisionId", "status", "engineVersion", "totalAssets", "assertionsPassed", "duplicateSubmissionDeduplicated", "refreshedResultMatches"]}
    summary["rowsHash"] = digest(report["rows"])
    summary["regressionCount"] = len(report.get("validation", {}).get("regressions", []))
    print(json.dumps(summary, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        code = str(error)
        print(json.dumps({"ok": False, "code": code if re.match(r"^[A-Z0-9_]+$", code) else "PRIVATE_APPLICATION_CHECK_FAILED"}))
        raise SystemExit(1)
