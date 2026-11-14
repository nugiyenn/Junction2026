# Aiven setup: Kafka decision events and ClickHouse analytics

What flows where:

- Every audit event (a quote, an order, a human decision) is published to the Kafka topic `trade-events` right after it is committed to Postgres. Only these fields leave the gateway: `id, at, actor, action, mandateId, quoteId, orderId, hash`. No summary text, no prices.
- Aiven's own Kafka to ClickHouse integration ingests the topic into `trade_events`. There is no consumer to run.
- `orders_fact` in ClickHouse holds the orders (amounts, carbon, products). It is loaded by `scripts/clickhouse-backfill.mts`, because the event stream deliberately carries no amounts. It is a snapshot: re-run the script to refresh it.
- `/api/stats` answers from ClickHouse when `AIVEN_CLICKHOUSE_URL` is set and reachable, otherwise from Postgres, and the `/stats` page says which one answered.

## 1. Kafka

1. Aiven console: create an **Aiven for Apache Kafka** service. Under *Topics* create `trade-events` (1 to 3 partitions, retention as you like).
2. Under *Users* (or the service overview) use the SASL user `avnadmin`, or create a user with write access to `trade-events`. Enable SASL authentication if the service shows it off (*Advanced configuration*, `kafka_authentication_methods.sasl`).
3. From the service overview note: the **SASL** host and port (not the client-certificate port), the username and password, and download the **CA certificate** (`ca.pem`).

Environment variables (local `.env.local` and Vercel, Project, Settings, Environment Variables):

| Name | Value |
| --- | --- |
| `AIVEN_KAFKA_BROKERS` | `host:port` of the SASL listener |
| `AIVEN_KAFKA_USERNAME` | the SASL user |
| `AIVEN_KAFKA_PASSWORD` | its password |
| `AIVEN_KAFKA_CA` | the CA certificate: `base64 -i ca.pem \| tr -d '\n'` (or the PEM on one line with literal `\n`) |
| `AIVEN_KAFKA_SASL_MECHANISM` | optional: `scram-sha-256` (default), `scram-sha-512` or `plain` |

Place an order, then check the topic in the Aiven console (*Topics, trade-events, Fetch messages*, format JSON).

## 2. ClickHouse

1. Create an **Aiven for ClickHouse** service.
2. Open the query editor and run the first two statements of `scripts/clickhouse.sql` (`orders_fact`, `trade_events`).
3. Copy the service URI (HTTPS, port shown in the console) into `AIVEN_CLICKHOUSE_URL` in the form `https://avnadmin:PASSWORD@HOST:PORT` (locally and on Vercel).
   Tables are created in the `default` database; to use another, run the SQL there and set `AIVEN_CLICKHOUSE_DATABASE`.
4. Load the orders: `node --conditions=react-server --env-file=.env.local scripts/clickhouse-backfill.mts`.

## 3. Kafka to ClickHouse integration

Aiven console: the ClickHouse service, *Integrations*, *Apache Kafka*, choose the Kafka service, then add a table:

- Name `trade_events_queue`, topic `trade-events`, format `JSONEachRow`, consumer group `clickhouse-trade-events`
- Columns: `id String, at String, actor String, action String, mandateId Nullable(String), quoteId Nullable(String), orderId Nullable(String), hash Nullable(String)`

The same through the CLI:

```bash
avn service integration-create --integration-type clickhouse_kafka \
  --source-service <kafka-service> --dest-service <clickhouse-service> \
  --user-config-json '{"tables":[{"name":"trade_events_queue","group_name":"clickhouse-trade-events","data_format":"JSONEachRow","topics":[{"name":"trade-events"}],"columns":[{"name":"id","type":"String"},{"name":"at","type":"String"},{"name":"actor","type":"String"},{"name":"action","type":"String"},{"name":"mandateId","type":"Nullable(String)"},{"name":"quoteId","type":"Nullable(String)"},{"name":"orderId","type":"Nullable(String)"},{"name":"hash","type":"Nullable(String)"}]}]}'
```

Then run the third statement of `scripts/clickhouse.sql` (the materialized view), after replacing `<your-kafka-service-name>` with the Kafka service's name. The Kafka-engine table is `service_<kafka-service>.trade_events_queue`; verify with `SHOW TABLES FROM service_<kafka-service>`.

## 4. Check

- `/stats` Infrastructure strip: Kafka "ok" after the first publish by that server instance; ClickHouse "ok" with the number of Kafka events ingested.
- In ClickHouse: `SELECT action, count() FROM trade_events GROUP BY action`.
- Not configured or failing is shown as such on the page, never as healthy; stats then come from Postgres.

## Synthetic demo history

`order_history` holds generated past orders for `demo-hotel` and `demo-school` (about 90 days, marked synthetic by the table itself and labelled "Demo history" on the page). Create it with `scripts/seed.mts` (additive) or just run `scripts/seed-history.mts`, which also creates the table. The demo reset does not touch it.
