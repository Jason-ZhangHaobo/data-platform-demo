export const initialPythonCode = `def transform(data, params):
    allowed = {row["client_id"] for row in data["accounts"] if row["advisor_id"] == params["advisor_id"]}
    holdings = {}
    securities = {}
    seen = set()
    for row in data["positions"]:
        if row["client_id"] in allowed and row["trade_date"] == params["business_date"] and row["position_id"] not in seen:
            seen.add(row["position_id"])
            client_id = row["client_id"]
            holdings[client_id] = holdings.get(client_id, Decimal("0")) + Decimal(row.get("market_value") or "0")
            securities.setdefault(client_id, set()).add(row["security_code"])
    cash = {}
    for row in data["cash"]:
        if row["client_id"] in allowed and row["trade_date"] == params["business_date"]:
            client_id = row["client_id"]
            cash[client_id] = cash.get(client_id, Decimal("0")) + Decimal(row.get("available_cash") or "0")
    result = []
    for client_id in sorted(allowed):
        holding = holdings.get(client_id, Decimal("0"))
        available = cash.get(client_id, Decimal("0"))
        result.append({"client_id": client_id, "holding_market_value": holding, "available_cash": available, "total_assets": holding + available, "security_count": len(securities.get(client_id, set()))})
    return result`;
