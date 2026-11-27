CREATE TEMPORARY TABLE live_quote_events (
  security_code STRING,
  event_ms BIGINT,
  volume BIGINT,
  event_ts AS TO_TIMESTAMP_LTZ(event_ms, 3),
  WATERMARK FOR event_ts AS event_ts - INTERVAL '2' SECOND
) WITH (
  'connector' = 'kafka',
  'topic' = 'shuduo-live-quotes',
  'properties.bootstrap.servers' = '@BROKER@',
  'properties.group.id' = 'shuduo-live-@SESSION@',
  'scan.startup.mode' = 'specific-offsets',
  'scan.startup.specific-offsets' = '@OFFSETS@',
  'scan.topic-partition-discovery.interval' = '0 ms',
  'format' = 'json',
  'json.ignore-parse-errors' = 'true'
);

CREATE TEMPORARY VIEW fictional_quotes AS
SELECT security_code, volume, event_ts
FROM live_quote_events
WHERE security_code IN ('SEC-DEMO-001', 'SEC-DEMO-002') AND volume BETWEEN 0 AND 1000000000;

CREATE TEMPORARY TABLE live_quote_windows (
  session_id STRING,
  window_start_utc STRING,
  security_code STRING,
  event_count BIGINT,
  total_volume BIGINT
) WITH (
  'connector' = 'kafka',
  'topic' = 'shuduo-live-windows',
  'properties.bootstrap.servers' = '@BROKER@',
  'format' = 'json',
  'sink.delivery-guarantee' = 'exactly-once',
  'sink.transactional-id-prefix' = 'shuduo-live-@SESSION@',
  'properties.transaction.timeout.ms' = '60000'
);

INSERT INTO live_quote_windows
SELECT '@SESSION@', DATE_FORMAT(window_start, 'yyyy-MM-dd HH:mm:ss'), security_code, COUNT(*), SUM(volume)
FROM TABLE(TUMBLE(TABLE fictional_quotes, DESCRIPTOR(event_ts), INTERVAL '10' SECOND))
GROUP BY window_start, window_end, security_code;
