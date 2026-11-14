import 'server-only';
import type { BuyerStatsCore, OrderOutcome, StatsOrder, StatsStream } from '../types/index.ts';

// Aiven for ClickHouse over its HTTP interface (plain fetch, no client library). Two tables, DDL in
// scripts/clickhouse.sql: `trade_events` is filled by Aiven's Kafka integration, `orders_fact` by
// scripts/clickhouse-backfill.mts.

export const clickhouseConfigured = () => !!process.env.AIVEN_CLICKHOUSE_URL;

export interface ClickHouseDeps {
  fetch?: typeof fetch;
  /** Overrides AIVEN_CLICKHOUSE_URL. */
  url?: string;
  timeoutMs?: number;
}

type Row = Record<string, unknown>;

/**
 * Runs one query. Values go in as ClickHouse query parameters ({name:Type} in the SQL, `params.name` here),
 * never into the SQL text. Credentials in the URL (https://user:password@host:port) become a Basic auth header.
 */
export async function chQuery(sql: string, params: Record<string, string> = {}, deps: ClickHouseDeps = {}): Promise<Row[]> {
  const raw = deps.url ?? process.env.AIVEN_CLICKHOUSE_URL;
  if (!raw) throw new Error('Missing AIVEN_CLICKHOUSE_URL: cannot query clickhouse');
  const { endpoint, headers } = target(raw);
  for (const [k, v] of Object.entries(params)) endpoint.searchParams.set(`param_${k}`, v);
  // Plain numbers rather than quoted 64-bit integers, and NaN (an average over no rows) as null.
  endpoint.searchParams.set('output_format_json_quote_64bit_integers', '0');
  const res = await (deps.fetch ?? fetch)(endpoint, {
    method: 'POST',
    headers,
    body: `${sql}\nFORMAT JSON`,
    signal: AbortSignal.timeout(deps.timeoutMs ?? 8000),
  }).catch((err) => {
    // Node's fetch says only "fetch failed"; the reason (DNS, refused, timeout) is on the cause.
    const cause = (err as { cause?: { code?: string } }).cause?.code ?? (err as Error).name;
    throw new Error(`ClickHouse unreachable (${cause})`);
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`ClickHouse answered ${res.status}: ${text.slice(0, 300).trim()}`);
  return (JSON.parse(text) as { data: Row[] }).data;
}

function target(raw: string, extra: Record<string, string> = {}) {
  const url = new URL(raw);
  const headers: Record<string, string> = {};
  if (url.username) {
    headers.Authorization = `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64')}`;
  }
  url.username = '';
  url.password = '';
  url.searchParams.set('database', process.env.AIVEN_CLICKHOUSE_DATABASE || 'default');
  for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);
  return { endpoint: url, headers };
}

const CONFIRMED = `outcome IN ('auto_approved', 'approved')`;
const FROM = `FROM orders_fact FINAL WHERE mandate_id = {mandate:String}`;

/** The queries behind a buyer's stats. `quantileExactInclusive` interpolates linearly, like the Postgres-side code. */
export const STATS_SQL = {
  summary: `SELECT count() AS orders, countIf(synthetic = 0) AS real_orders, countIf(synthetic = 1) AS synthetic_orders,
  sumIf(total, ${CONFIRMED}) AS confirmed_spend, avg(decision_seconds) AS avg_decision, avg(avg_co2) AS avg_co2,
  avg(avg_reliability) AS avg_reliability, quantileExactInclusive(0.5)(total) AS median, quantileExactInclusive(0.9)(total) AS p90
${FROM}`,
  outcomes: `SELECT outcome, count() AS n ${FROM} GROUP BY outcome`,
  weeks: `SELECT toString(toStartOfWeek(at, 1)) AS week, sumIf(total, ${CONFIRMED}) AS spend,
  sumIf(total, ${CONFIRMED} AND synthetic = 1) AS synthetic_spend, count() AS orders
${FROM} GROUP BY week ORDER BY week`,
  topProducts: `SELECT p AS product_id, any(n) AS name, sum(t) AS spend, count() AS orders
FROM orders_fact FINAL ARRAY JOIN line_product_ids AS p, line_names AS n, line_totals AS t
WHERE mandate_id = {mandate:String} AND ${CONFIRMED}
GROUP BY p ORDER BY spend DESC LIMIT 5`,
  stream: `SELECT action, count() AS n, toString(max(at)) AS latest FROM trade_events WHERE mandate_id = {mandate:String} GROUP BY action`,
};

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const OUTCOMES: OrderOutcome[] = ['auto_approved', 'approved', 'declined', 'rejected', 'pending'];

/** The same numbers `buildStats` computes from rows, computed inside ClickHouse. Weeks are not gap-filled here. */
export async function chStats(mandateId: string, deps: ClickHouseDeps = {}): Promise<BuyerStatsCore> {
  const p = { mandate: mandateId };
  const [summary, outcomes, weeks, top] = await Promise.all([
    chQuery(STATS_SQL.summary, p, deps),
    chQuery(STATS_SQL.outcomes, p, deps),
    chQuery(STATS_SQL.weeks, p, deps),
    chQuery(STATS_SQL.topProducts, p, deps),
  ]);
  const s = summary[0] ?? {};
  const counts = Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<OrderOutcome, number>;
  for (const r of outcomes) {
    const outcome = String(r.outcome) as OrderOutcome;
    if (outcome in counts) counts[outcome] = num(r.n) ?? 0;
  }
  const median = num(s.median);
  const p90 = num(s.p90);
  return {
    totals: {
      orders: num(s.orders) ?? 0,
      realOrders: num(s.real_orders) ?? 0,
      syntheticOrders: num(s.synthetic_orders) ?? 0,
      confirmedSpend: num(s.confirmed_spend) ?? 0,
    },
    weeks: weeks.map((w) => ({
      week: String(w.week),
      spend: num(w.spend) ?? 0,
      syntheticSpend: num(w.synthetic_spend) ?? 0,
      orders: num(w.orders) ?? 0,
    })),
    outcomes: counts,
    avgDecisionSeconds: num(s.avg_decision),
    avgCo2PerKg: num(s.avg_co2),
    avgReliability: num(s.avg_reliability),
    topProducts: top.map((t) => ({ productId: String(t.product_id), name: String(t.name), spend: num(t.spend) ?? 0, orders: num(t.orders) ?? 0 })),
    orderSize: median !== null && p90 !== null ? { median, p90 } : null,
  };
}

/** Decision events that reached ClickHouse through the Kafka integration, for one buyer. */
export async function chStream(mandateId: string, deps: ClickHouseDeps = {}): Promise<StatsStream> {
  const rows = await chQuery(STATS_SQL.stream, { mandate: mandateId }, deps);
  const byAction: Record<string, number> = {};
  let latest: string | null = null;
  for (const r of rows) {
    byAction[String(r.action)] = num(r.n) ?? 0;
    const at = String(r.latest);
    if (!latest || at > latest) latest = at;
  }
  return {
    events: Object.values(byAction).reduce((a, b) => a + b, 0),
    latestAt: latest ? `${latest.replace(' ', 'T')}Z` : null,
    byAction,
  };
}

/** Loads orders into `orders_fact` (the backfill script). Re-loading the same ids replaces them. */
export async function chInsertOrders(orders: StatsOrder[], deps: ClickHouseDeps = {}): Promise<void> {
  if (orders.length === 0) return;
  const raw = deps.url ?? process.env.AIVEN_CLICKHOUSE_URL;
  if (!raw) throw new Error('Missing AIVEN_CLICKHOUSE_URL: cannot load clickhouse');
  const { endpoint, headers } = target(raw, { query: 'INSERT INTO orders_fact FORMAT JSONEachRow', date_time_input_format: 'best_effort' });
  const body = orders
    .map((o) =>
      JSON.stringify({
        id: o.id,
        at: o.at,
        mandate_id: o.mandateId,
        outcome: o.outcome,
        synthetic: o.synthetic ? 1 : 0,
        total: o.total,
        decision_seconds: o.decisionSeconds,
        avg_co2: o.avgCo2,
        avg_reliability: o.avgReliability,
        line_product_ids: o.lines.map((l) => l.productId),
        line_names: o.lines.map((l) => l.name),
        line_totals: o.lines.map((l) => l.total),
      })
    )
    .join('\n');
  const res = await (deps.fetch ?? fetch)(endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(deps.timeoutMs ?? 30000) });
  if (!res.ok) throw new Error(`ClickHouse answered ${res.status}: ${(await res.text()).slice(0, 300).trim()}`);
}
