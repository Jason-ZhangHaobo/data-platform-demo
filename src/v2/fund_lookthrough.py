"""Authoritative synthetic inputs and independent assertions for fund look-through."""
from collections import defaultdict
from decimal import Decimal
from hashlib import sha256
import json
from pathlib import Path
import re

FIXTURES = Path(__file__).resolve().parents[2] / "fixtures/fund-lookthrough"
CONTRACT = json.loads((FIXTURES / "contract.json").read_text())
COLUMNS = {table["name"]: tuple(name for name, _ in table["columns"]) for table in CONTRACT["sourceTables"]}


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
    fields = set(expected[0])
    require(all(set(row) == fields and all(isinstance(value, str) for value in row.values()) for row in rows),
            "FUND_LOOKTHROUGH_ROWS_MISMATCH")
    key = lambda row: (row["portfolio_id"], row["trade_date"], row["asset_class"])
    require(sorted(rows, key=key) == sorted(expected, key=key), "FUND_LOOKTHROUGH_ROWS_MISMATCH")
    actual_totals = defaultdict(Decimal)
    for row in rows:
        actual_totals[row["portfolio_id"]] += Decimal(row["exposure_amount"])
    require(dict(actual_totals) == totals, "FUND_LOOKTHROUGH_TOTALS_MISMATCH")


def registered_inputs(context):
    case = json.loads((FIXTURES / "case.json").read_text())
    require(context.get("id") == case["id"] and context.get("managerId") == case["managerId"]
            and context.get("businessDate") == case["businessDate"]
            and context.get("classification") == case["classification"]
            and context.get("outputContractId") == CONTRACT["id"]
            and context.get("expected") == case["expected"], "FUND_LOOKTHROUGH_CONTEXT_MISMATCH")
    totals = validate_inputs(case)
    source = case["tables"]
    portfolios = [row for row in source["portfolios"] if row[1] == case["managerId"]]
    ids = {row[0] for row in portfolios}
    day = case["businessDate"]
    positions = [row for row in source["fund_positions"] if row[1] in ids and row[3] == day]
    funds = {row[2] for row in positions}
    allocations = [row for row in source["fund_allocations"] if row[0] in funds and row[1] == day]
    scoped = {"portfolios": portfolios, "fund_positions": positions, "fund_allocations": allocations}
    tables = [{**table, "rows": scoped[table["name"]]} for table in CONTRACT["sourceTables"]]
    require(context.get("tables") == tables, "FUND_LOOKTHROUGH_INPUT_MISMATCH")
    return tables, case["expected"], totals


def verify_fund_output(rows, context):
    _, expected, totals = registered_inputs(context)
    issues = []
    try:
        assert_output(rows, expected, totals)
    except ValueError:
        issues.append("组合、交易日、资产类别或敞口数值与独立预期不符")
    digest = sha256(json.dumps(expected, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
    return {
        "passed": not issues,
        "issues": issues,
        "assertions": ["组合及交易日隔离", "资产类别敞口金额与占比", "未穿透余额", "组合市值守恒"],
        "assertionEvidence": {"protocol": "shuduo-securities-assertion-evidence/v1",
                              "verifierRevision": "fund-lookthrough-v1", "contentHash": digest},
    }
