CREATE TEMPORARY TABLE quote_events (
  event_id STRING,
  `sequence` BIGINT,
  security_code STRING,
  event_time STRING,
  price STRING,
  volume BIGINT,
  received_at AS PROCTIME()
) WITH (
  'connector' = 'kafka',
  'topic' = 'shuduo-quote-events',
  'properties.bootstrap.servers' = '@BROKER@',
  'properties.group.id' = 'shuduo-flink-quote-lab',
  'scan.startup.mode' = 'earliest-offset',
  'format' = 'json'
);

CREATE TEMPORARY TABLE latest_quotes (
  security_code STRING,
  `sequence` BIGINT,
  event_id STRING,
  event_time STRING,
  price STRING,
  volume BIGINT,
  PRIMARY KEY (security_code) NOT ENFORCED
) WITH (
  'connector' = 'upsert-kafka',
  'topic' = 'shuduo-latest-quotes',
  'properties.bootstrap.servers' = '@BROKER@',
  'key.format' = 'json',
  'value.format' = 'json',
  'sink.delivery-guarantee' = 'exactly-once',
  'sink.transactional-id-prefix' = 'shuduo-flink-quote-lab',
  'properties.transaction.timeout.ms' = '60000'
);

INSERT INTO latest_quotes
SELECT security_code, `sequence`, event_id, event_time, price, volume
FROM (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY security_code ORDER BY `sequence` DESC) AS latest_rank
  FROM (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY event_id ORDER BY received_at ASC) AS event_rank
    FROM quote_events
    WHERE event_id LIKE 'EVT-%' AND security_code LIKE 'SEC-DEMO-%'
      AND `sequence` > 0 AND TRY_CAST(price AS DECIMAL(18,2)) > 0 AND volume >= 0
  )
  WHERE event_rank = 1
)
WHERE latest_rank = 1;
