-- One-level look-through of synthetic fund holdings for a single manager and date.
WITH authorized_portfolios AS (
  SELECT DISTINCT portfolio_id
  FROM portfolios
  WHERE manager_id = '{{manager_id}}'
), unique_positions AS (
  SELECT DISTINCT p.position_id, p.portfolio_id, p.fund_code,
    CAST(p.market_value AS DECIMAL(18, 2)) AS market_value
  FROM fund_positions p
  JOIN authorized_portfolios a ON p.portfolio_id = a.portfolio_id
  WHERE p.trade_date = '{{trade_date}}'
), fund_values AS (
  SELECT portfolio_id, fund_code, SUM(market_value) AS fund_value
  FROM unique_positions
  GROUP BY portfolio_id, fund_code
), portfolio_totals AS (
  SELECT portfolio_id, SUM(fund_value) AS total_value
  FROM fund_values
  GROUP BY portfolio_id
), unique_allocations AS (
  SELECT DISTINCT fund_code, underlying_id, asset_class,
    CAST(allocation_weight AS DECIMAL(9, 6)) AS allocation_weight
  FROM fund_allocations
  WHERE trade_date = '{{trade_date}}'
), weights AS (
  SELECT fund_code, asset_class, CAST(SUM(allocation_weight) AS DECIMAL(9, 6)) AS weight
  FROM unique_allocations
  GROUP BY fund_code, asset_class
), covered AS (
  SELECT fund_code, CAST(SUM(weight) AS DECIMAL(9, 6)) AS total_weight
  FROM weights
  GROUP BY fund_code
), allocated AS (
  SELECT p.portfolio_id, w.asset_class,
    CAST(p.fund_value AS DECIMAL(20, 2)) * w.weight AS amount
  FROM fund_values p
  JOIN weights w ON p.fund_code = w.fund_code
  UNION ALL
  SELECT p.portfolio_id, '未穿透' AS asset_class,
    CAST(p.fund_value AS DECIMAL(20, 2)) * (1 - COALESCE(c.total_weight, 0)) AS amount
  FROM fund_values p
  LEFT JOIN covered c ON p.fund_code = c.fund_code
  WHERE COALESCE(c.total_weight, 0) < 1
), exposure AS (
  SELECT portfolio_id, asset_class, SUM(amount) AS amount
  FROM allocated
  GROUP BY portfolio_id, asset_class
)
SELECT e.portfolio_id, '{{trade_date}}' AS trade_date, e.asset_class,
  CAST(e.amount AS DECIMAL(20, 2)) AS exposure_amount,
  CAST(CASE WHEN t.total_value > 0 THEN ROUND(e.amount / t.total_value, 6) ELSE 0 END AS DECIMAL(12, 6)) AS exposure_ratio
FROM exposure e
JOIN portfolio_totals t ON e.portfolio_id = t.portfolio_id
ORDER BY e.portfolio_id, e.asset_class
