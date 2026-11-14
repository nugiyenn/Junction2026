-- Run in the Aiven ClickHouse query editor (or clickhouse-client), in this order. See scripts/aiven-setup.md.

-- 1. Orders for the stats. Loaded by scripts/clickhouse-backfill.mts (order_history + real orders).
--    ReplacingMergeTree: loading the same id again replaces it; queries read with FINAL.
CREATE TABLE IF NOT EXISTS orders_fact (
  id String,
  at DateTime64(3, 'UTC'),
  mandate_id LowCardinality(String),
  outcome LowCardinality(String),          -- auto_approved | approved | declined | rejected | pending
  synthetic UInt8,                         -- 1 = generated demo history, 0 = a real order
  total Float64,                           -- EUR ex VAT
  decision_seconds Nullable(Float64),
  avg_co2 Nullable(Float64),
  avg_reliability Nullable(Float64),
  line_product_ids Array(String),
  line_names Array(String),
  line_totals Array(Float64)
) ENGINE = ReplacingMergeTree
ORDER BY (mandate_id, id);

-- 2. Decision events from Kafka. The final table the stats read.
CREATE TABLE IF NOT EXISTS trade_events (
  id String,
  at DateTime64(3, 'UTC'),
  actor LowCardinality(String),
  action LowCardinality(String),
  mandate_id Nullable(String),
  quote_id Nullable(String),
  order_id Nullable(String),
  hash Nullable(String)
) ENGINE = ReplacingMergeTree
ORDER BY (action, id);

-- 3. After creating the Kafka integration (aiven-setup.md step 4), Aiven makes a Kafka-engine table
--    `service_<your-kafka-service-name>`.`trade_events_queue`. This view copies every message into trade_events.
--    Replace <your-kafka-service-name> with the Kafka service's name before running.
CREATE MATERIALIZED VIEW IF NOT EXISTS trade_events_mv TO trade_events AS
SELECT
  id,
  parseDateTime64BestEffort(at, 3, 'UTC') AS at,
  actor,
  action,
  mandateId AS mandate_id,
  quoteId AS quote_id,
  orderId AS order_id,
  hash
FROM `service_<your-kafka-service-name>`.`trade_events_queue`;
