CREATE TEMPORARY TABLE quote_events (
  security_code STRING,
  event_ms BIGINT,
  volume BIGINT,
  event_ts AS TO_TIMESTAMP_LTZ(event_ms, 3),
  WATERMARK FOR event_ts AS event_ts - INTERVAL '2' SECOND
) WITH (
  'connector' = 'kafka',
  'topic' = 'shuduo-quote-events',
  'properties.bootstrap.servers' = '@BROKER@',
  'properties.group.id' = 'shuduo-flink-window-lab',
  'scan.startup.mode' = 'earliest-offset',
  'format' = 'json'
);

CREATE TEMPORARY TABLE quote_windows (
  window_start_utc STRING,
  security_code STRING,
  event_count BIGINT,
  total_volume BIGINT
) WITH (
  'connector' = 'kafka',
  'topic' = 'shuduo-quote-windows',
  'properties.bootstrap.servers' = '@BROKER@',
  'format' = 'json',
  'sink.delivery-guarantee' = 'exactly-once',
  'sink.transactional-id-prefix' = 'shuduo-flink-window-lab',
  'properties.transaction.timeout.ms' = '60000'
);

INSERT INTO quote_windows
SELECT DATE_FORMAT(window_start, 'yyyy-MM-dd HH:mm:ss'), security_code, COUNT(*), SUM(volume)
FROM TABLE(TUMBLE(TABLE quote_events, DESCRIPTOR(event_ts), INTERVAL '10' SECOND))
GROUP BY window_start, window_end, security_code;
