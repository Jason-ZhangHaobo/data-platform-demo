const sql = `WITH p AS (
  SELECT client_id,
         SUM(COALESCE(market_value, 0)) AS holding_market_value,
         COUNT(DISTINCT security_code) AS security_count
  FROM positions
  WHERE trade_date = '{{trade_date}}'
  GROUP BY client_id
), c AS (
  SELECT client_id, SUM(COALESCE(available_cash, 0)) AS available_cash
  FROM cash
  WHERE trade_date = '{{trade_date}}'
  GROUP BY client_id
)
SELECT a.client_id,
       CAST(COALESCE(p.holding_market_value, 0) AS DECIMAL(18,2)) AS holding_market_value,
       CAST(COALESCE(c.available_cash, 0) AS DECIMAL(18,2)) AS available_cash,
       CAST(COALESCE(p.holding_market_value, 0) + COALESCE(c.available_cash, 0) AS DECIMAL(18,2)) AS total_assets,
       COALESCE(p.security_count, 0) AS security_count
FROM accounts a
LEFT JOIN p ON a.client_id = p.client_id
LEFT JOIN c ON a.client_id = c.client_id
WHERE a.advisor_id = '{{advisor_id}}'
ORDER BY a.client_id`;

const context = Object.freeze({
  id: "fc-private-smoke",
  name: "FC私有烟测 · 虚构客户资产",
  businessDate: "2026-09-10",
  advisorId: "ADVISOR-DEMO-W2",
  classification: "SYNTHETIC",
  tables: [
    {
      name: "accounts",
      columns: [
        ["client_id", "STRING"],
        ["advisor_id", "STRING"],
      ],
      rows: [["CLIENT-W2-001", "ADVISOR-DEMO-W2"]],
    },
    {
      name: "positions",
      columns: [
        ["position_id", "STRING"],
        ["client_id", "STRING"],
        ["security_code", "STRING"],
        ["asset_class", "STRING"],
        ["industry", "STRING"],
        ["market_value", "DECIMAL(18,2)"],
        ["trade_date", "STRING"],
      ],
      rows: [
        ["POS-W2-001", "CLIENT-W2-001", "SEC-DEMO-W2-A", "股票", "金融", "100.00", "2026-09-10"],
        ["POS-W2-002", "CLIENT-W2-001", "SEC-DEMO-W2-B", "基金", "非银金融", "50.00", "2026-09-10"],
      ],
    },
    {
      name: "cash",
      columns: [
        ["client_id", "STRING"],
        ["available_cash", "DECIMAL(18,2)"],
        ["trade_date", "STRING"],
      ],
      rows: [["CLIENT-W2-001", "25.00", "2026-09-10"]],
    },
  ],
  expected: [
    {
      client_id: "CLIENT-W2-001",
      holding_market_value: "150.00",
      available_cash: "25.00",
      total_assets: "175.00",
      security_count: 2,
    },
  ],
});

export function privateSparkSmokePayload({ requestId, submittedAt }) {
  return {
    protocol: "shuduo-spark-execution/v1",
    requestId,
    submittedAt,
    sql,
    context: structuredClone(context),
    validationContexts: [],
  };
}
