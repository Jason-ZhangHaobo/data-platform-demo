-- 参考 SQL · 虚构证券数据 · Spark SQL
-- 现金独立聚合，避免与多条持仓关联后重复累计。
WITH eligible_clients AS (
  SELECT DISTINCT client_id
  FROM accounts
  WHERE advisor_id = '{{advisor_id}}'
),
position_totals AS (
  SELECT client_id,
         SUM(COALESCE(market_value, 0)) AS holding_market_value,
         COUNT(DISTINCT security_code) AS security_count
  FROM (
    SELECT DISTINCT position_id, client_id, security_code, market_value
    FROM positions
    WHERE trade_date = '{{trade_date}}'
  ) deduplicated_positions
  GROUP BY client_id
),
cash_totals AS (
  SELECT client_id,
         SUM(COALESCE(available_cash, 0)) AS available_cash
  FROM cash
  WHERE trade_date = '{{trade_date}}'
  GROUP BY client_id
)
SELECT c.client_id,
       CAST(COALESCE(p.holding_market_value, 0) AS DECIMAL(18,2)) AS holding_market_value,
       CAST(COALESCE(b.available_cash, 0) AS DECIMAL(18,2)) AS available_cash,
       CAST(COALESCE(p.holding_market_value, 0)
          + COALESCE(b.available_cash, 0) AS DECIMAL(18,2)) AS total_assets,
       COALESCE(p.security_count, 0) AS security_count
FROM eligible_clients c
LEFT JOIN position_totals p ON c.client_id = p.client_id
LEFT JOIN cash_totals b ON c.client_id = b.client_id
ORDER BY c.client_id
