"""Registered synthetic distribution contracts. No caller-supplied schema or oracle."""
import hashlib
import json
import re
from decimal import Decimal, localcontext, InvalidOperation
from pathlib import Path

REGISTRY = json.loads(Path(__file__).with_name("output-contracts.json").read_text())
METADATA = json.loads(Path(__file__).with_name("output-contract-metadata.json").read_text())["contracts"]
CONTRACTS = [{**{k:v for k,v in m.items() if k not in ("contextIds", "metrics", "constraints")}, "cases": next(c["cases"] for c in REGISTRY["contracts"] if c["id"] == m["id"])} for m in METADATA]


def registered_contract(context):
    selected = next((c for c in CONTRACTS if any(v["id"] == context.get("id") for v in c["cases"])), None)
    if selected is None:
        if context.get("outputContractId") is not None:
            raise ValueError("输出契约未登记")
        return None
    case = next(v for v in selected["cases"] if v["id"] == context["id"])
    if context.get("outputContractId") != selected["id"] or context.get("expected") != case["expected"]:
        raise ValueError("输出契约或独立预期不一致")
    return selected


def number(value, field):
    if isinstance(value, bool) or not isinstance(value, (str, int, float, Decimal)):
        return None
    text = str(value)
    if len(text) > 64 or re.fullmatch(r"\d{1,38}(?:\.\d{1,18})?", text) is None:
        return None
    parsed = Decimal(text)
    scale = field.get("scale", 0)
    with localcontext() as ctx:
        ctx.prec = 64
        try:
            if parsed != parsed.quantize(Decimal(1).scaleb(-scale)) or parsed < Decimal(field.get("min", "0")):
                return None
        except InvalidOperation:
            return None
    if "max" in field and parsed > Decimal(field["max"]):
        return None
    return parsed


def preflight_context(context):
    contract = registered_contract(context)
    if contract is None:
        return
    tables = {t["name"]: t for t in context["tables"]}
    accounts = tables["accounts"]
    ai = {name: i for i, (name, _) in enumerate(accounts["columns"])}
    clients = {r[ai["client_id"]] for r in accounts["rows"] if r[ai["advisor_id"]] == context["advisorId"]}
    positions = tables["positions"]
    ix = {name: i for i, (name, _) in enumerate(positions["columns"])}
    seen = {}
    for row in positions["rows"]:
        if row[ix["client_id"]] not in clients or row[ix["trade_date"]] != context["businessDate"]:
            continue
        if not isinstance(row[ix["position_id"]], str) or not row[ix["position_id"]].strip():
            raise ValueError("分布输入缺少持仓编号")
        amount = number("0.00" if row[ix["market_value"]] is None else row[ix["market_value"]], {"scale": 2})
        if amount is None or amount >= Decimal("10000000000000000"):
            raise ValueError("分布输入须为非负且符合DECIMAL(18,2)的持仓市值")
        key = tuple(row[ix[k]] for k in ("client_id", "trade_date", "position_id"))
        fingerprint = (row[ix["security_code"]], amount, *[(row[ix[d]] or "").strip() or "未分类" for d in ("asset_class", "industry")])
        if key in seen and seen[key] != fingerprint:
            raise ValueError("同一持仓编号存在冲突记录，未执行SQL")
        seen[key] = fingerprint


def preflight_contexts(context, others):
    contract = registered_contract(context)
    for item in [context, *(others or [])]:
        selected = registered_contract(item)
        if (selected or {}).get("id") != (contract or {}).get("id"):
            raise ValueError("不能混用不同输出契约的回归场景")
        preflight_context(item)


def verify_output(rows, context):
    contract = registered_contract(context)
    if contract is None:
        raise ValueError("此校验器仅接受已登记分布契约")
    expected = next(v["expected"] for v in contract["cases"] if v["id"] == context["id"])
    fields, keys = contract["fields"], contract["keyFields"]
    field_names = {f["name"] for f in fields}
    expected_map = {tuple(r[k] for k in keys): r for r in expected}
    mismatches, issues = [], []
    def add(kind, key=None, field=None):
        # Only registered expected keys are safe to expose. Never echo unknown
        # row labels, identifiers or arbitrary SQL-generated values.
        issues.append({"ROW_COUNT": "分组记录数不符", "OUTPUT_FIELDS": "输出字段不符", "OUT_OF_SCOPE": "包含未登记分组或无效复合键", "DUPLICATE_KEY": "分组复合键重复", "MISSING_KEY": "缺少登记分组", "VALUE_MISMATCH": "分组数值不符或精度/范围不合法"}[kind] + ("：" + field if field else ""))
        mismatches.append({"kind": kind, **({"key": dict(zip(keys, key))} if key in expected_map else {}), **({"field": field} if field else {})})
    if not isinstance(rows, list) or len(rows) > 1000:
        rows = []
        add("ROW_COUNT")
    if len(rows) != len(expected):
        add("ROW_COUNT")
    actual = {}
    for row in rows:
        if not isinstance(row, dict) or set(row) != field_names:
            add("OUTPUT_FIELDS")
            continue
        key = tuple(row[k] for k in keys)
        if any(not isinstance(v, str) or not v for v in key) or key not in expected_map:
            add("OUT_OF_SCOPE")
            continue
        actual.setdefault(key, []).append(row)
    for key, goal in expected_map.items():
        values = actual.get(key, [])
        if not values:
            add("MISSING_KEY", key)
        elif len(values) != 1:
            add("DUPLICATE_KEY", key)
        else:
            for field in fields:
                if field["type"] == "STRING":
                    continue  # All strings are part of the exact composite key.
                measured, wanted = number(values[0][field["name"]], field), number(goal[field["name"]], field)
                if measured is None or measured != wanted:
                    add("VALUE_MISMATCH", key, field["name"])
    return {"passed": not issues, "issues": list(dict.fromkeys(issues)),
            "assertions": ["顾问客户范围", "客户/交易日/分类复合键唯一", "持仓编号去重", "证券代码去重", "持仓市值占比不含现金", "未分类与仅现金客户", "零分母与金额/占比精度", "登记输出契约"],
            "comparison": {"schema": "shuduo-output-comparison/v1", "mismatches": mismatches[:20], "totalMismatches": len(mismatches), "truncated": len(mismatches) > 20},
            "assertionEvidence": {"protocol": "shuduo-securities-assertion-evidence/v1", "verifierRevision": "distribution-composite-v1", "contentHash": hashlib.sha256(json.dumps({"contract": {k:v for k,v in contract.items() if k != "cases"}, "expected": expected}, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()}}
