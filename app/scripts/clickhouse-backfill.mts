// Loads every order (real `orders` plus the synthetic `order_history`) from Postgres into ClickHouse `orders_fact`.
// Re-runnable: loading the same ids replaces them. Create the tables first with scripts/clickhouse.sql.
//
//   node --conditions=react-server --env-file=.env.local scripts/clickhouse-backfill.mts
//
// Needs AIVEN_DATABASE_URL and AIVEN_CLICKHOUSE_URL.
import { chInsertOrders } from '../src/lib/clickhouse.ts';
import { getPool } from '../src/lib/db.ts';
import { loadStatsOrders } from '../src/lib/stats.ts';

const pool = getPool();
const orders = await loadStatsOrders(pool);
for (let i = 0; i < orders.length; i += 1000) await chInsertOrders(orders.slice(i, i + 1000));
const synthetic = orders.filter((o) => o.synthetic).length;
console.log(`Loaded ${orders.length} orders into ClickHouse (${synthetic} synthetic demo history, ${orders.length - synthetic} real).`);
await pool.end();
