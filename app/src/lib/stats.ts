import 'server-only';
import { chStats, chStream, clickhouseConfigured, type ClickHouseDeps } from './clickhouse.ts';
import { getPool } from './db.ts';
import { kafkaStatus } from './events.ts';
import type { BuyerStats, BuyerStatsCore, InfraStatus, OrderOutcome, StatsOrder, StatsStream, StatsTopProduct, StatsWeek } from '../types/index.ts';

// Buyer statistics. `buildStats` is the pure aggregation over order rows (Postgres path); `getBuyerStats` picks the
// store: ClickHouse when AIVEN_CLICKHOUSE_URL is set and answers, otherwise Postgres, and says which one it was.

/**
 * Synthetic past orders for the demo mandates, written by scripts/seed-history.mts. A separate table from `orders`
 * (which has a quote foreign key, feeds the approvals inbox and is wiped by the demo reset); `source` can only be 'synthetic'.
 */
export const ORDER_HISTORY_DDL = `
  CREATE TABLE IF NOT EXISTS order_history (
    id text PRIMARY KEY,
    mandate_id text NOT NULL,
    created_at timestamptz NOT NULL,
    outcome text NOT NULL,
    total double precision NOT NULL,
    decision_seconds double precision,
    avg_co2 double precision,
    avg_reliability double precision,
    lines jsonb NOT NULL,
    source text NOT NULL DEFAULT 'synthetic' CHECK (source = 'synthetic')
  );
  CREATE INDEX IF NOT EXISTS order_history_mandate_idx ON order_history (mandate_id, created_at);
`;

const OUTCOMES: OrderOutcome[] = ['auto_approved', 'approved', 'declined', 'rejected', 'pending'];
const isConfirmed = (o: OrderOutcome) => o === 'auto_approved' || o === 'approved';

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Linear interpolation between closest ranks (the "inclusive" method), q in 0..1, `sorted` ascending. */
export function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const DAY = 86_400_000;

/** Monday (UTC) of the week an instant falls in, YYYY-MM-DD. */
export function weekStart(iso: string): string {
  const d = new Date(iso);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - ((d.getUTCDay() + 6) % 7) * DAY).toISOString().slice(0, 10);
}

/** Adds the weeks without orders between the first and last week, so a chart has no gaps. */
export function fillWeeks(weeks: StatsWeek[]): StatsWeek[] {
  if (weeks.length === 0) return [];
  const byWeek = new Map(weeks.map((w) => [w.week, w]));
  const sorted = [...byWeek.keys()].sort();
  const out: StatsWeek[] = [];
  for (let t = Date.parse(sorted[0]); t <= Date.parse(sorted[sorted.length - 1]); t += 7 * DAY) {
    const week = new Date(t).toISOString().slice(0, 10);
    out.push(byWeek.get(week) ?? { week, spend: 0, syntheticSpend: 0, orders: 0 });
  }
  return out;
}

/** All numbers for one buyer's orders. Spend counts confirmed orders only; order size and averages count every order. */
export function buildStats(orders: StatsOrder[]): BuyerStatsCore {
  const outcomes = Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<OrderOutcome, number>;
  const weeks = new Map<string, StatsWeek>();
  const products = new Map<string, StatsTopProduct>();
  let confirmedSpend = 0;

  for (const o of orders) {
    outcomes[o.outcome]++;
    const week = weekStart(o.at);
    const w = weeks.get(week) ?? { week, spend: 0, syntheticSpend: 0, orders: 0 };
    w.orders++;
    weeks.set(week, w);
    if (!isConfirmed(o.outcome)) continue;
    confirmedSpend += o.total;
    w.spend += o.total;
    if (o.synthetic) w.syntheticSpend += o.total;
    for (const l of o.lines) {
      const p = products.get(l.productId) ?? { productId: l.productId, name: l.name, spend: 0, orders: 0 };
      p.spend += l.total;
      p.orders++;
      products.set(l.productId, p);
    }
  }

  const totals = orders.map((o) => o.total).sort((a, b) => a - b);
  const present = (xs: (number | null)[]) => xs.filter((x): x is number => x !== null);
  return {
    totals: {
      orders: orders.length,
      realOrders: orders.filter((o) => !o.synthetic).length,
      syntheticOrders: orders.filter((o) => o.synthetic).length,
      confirmedSpend,
    },
    weeks: fillWeeks([...weeks.values()]),
    outcomes,
    avgDecisionSeconds: mean(present(orders.map((o) => o.decisionSeconds))),
    avgCo2PerKg: mean(present(orders.map((o) => o.avgCo2))),
    avgReliability: mean(present(orders.map((o) => o.avgReliability))),
    topProducts: [...products.values()].sort((a, b) => b.spend - a.spend || (a.productId < b.productId ? -1 : 1)).slice(0, 5),
    orderSize: totals.length ? { median: quantile(totals, 0.5), p90: quantile(totals, 0.9) } : null,
  };
}

// --- Postgres ---------------------------------------------------------------

type Row = Record<string, unknown>;
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Row[] }>;
}

interface StoredLine {
  productId: string;
  name: string;
  total: number | null;
}

/** Real orders and synthetic history, oldest first. Without `mandateId`, every buyer's (the ClickHouse backfill). */
export async function loadStatsOrders(db: Queryable, mandateId?: string): Promise<StatsOrder[]> {
  const [real, history] = await Promise.all([
    db.query('SELECT id, mandate_id, status, total, created_at, decided_by, decided_at, lines FROM orders WHERE ($1::text IS NULL OR mandate_id = $1)', [mandateId ?? null]),
    db.query('SELECT id, mandate_id, created_at, outcome, total, decision_seconds, avg_co2, avg_reliability, lines FROM order_history WHERE ($1::text IS NULL OR mandate_id = $1)', [mandateId ?? null]),
  ]);

  // Footprint and reliability of real orders' lines come from the catalog; history stores its own.
  const ids = [...new Set(real.rows.flatMap((r) => (r.lines as { productId: string }[]).map((l) => l.productId)))];
  const catalog = new Map<string, { co2: number | null; reliability: number | null }>();
  if (ids.length) {
    const { rows } = await db.query('SELECT id, co2_per_kg, delivery_reliability FROM products WHERE id = ANY($1::text[])', [ids]);
    for (const r of rows) catalog.set(String(r.id), { co2: r.co2_per_kg as number | null, reliability: r.delivery_reliability as number | null });
  }
  const lines = (raw: unknown) =>
    (raw as StoredLine[]).map((l) => ({ productId: l.productId, name: l.name, total: l.total ?? 0 }));
  const iso = (v: unknown) => new Date(v as string | Date).toISOString();

  const fromOrders = real.rows.map((r): StatsOrder => {
    const status = r.status as string;
    const decided = r.decided_by !== null;
    const outcome: OrderOutcome =
      status === 'pending_approval' ? 'pending' : status === 'confirmed' ? (decided ? 'approved' : 'auto_approved') : decided ? 'declined' : 'rejected';
    const l = r.lines as { productId: string }[];
    return {
      id: String(r.id),
      at: iso(r.created_at),
      mandateId: String(r.mandate_id),
      outcome,
      synthetic: false,
      total: r.total as number,
      decisionSeconds: r.decided_at ? (new Date(r.decided_at as string).getTime() - new Date(r.created_at as string).getTime()) / 1000 : null,
      avgCo2: mean(l.map((x) => catalog.get(x.productId)?.co2 ?? null).filter((x): x is number => x !== null)),
      avgReliability: mean(l.map((x) => catalog.get(x.productId)?.reliability ?? null).filter((x): x is number => x !== null)),
      lines: lines(r.lines),
    };
  });
  const fromHistory = history.rows.map(
    (r): StatsOrder => ({
      id: String(r.id),
      at: iso(r.created_at),
      mandateId: String(r.mandate_id),
      outcome: r.outcome as OrderOutcome,
      synthetic: true,
      total: r.total as number,
      decisionSeconds: r.decision_seconds as number | null,
      avgCo2: r.avg_co2 as number | null,
      avgReliability: r.avg_reliability as number | null,
      lines: lines(r.lines),
    })
  );
  return [...fromOrders, ...fromHistory].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

// --- Choosing the store -----------------------------------------------------

export interface StatsDeps {
  db?: Queryable;
  clickhouse?: ClickHouseDeps & { configured?: boolean };
  /** Answer from Postgres even when ClickHouse is configured. */
  forcePostgres?: boolean;
}

export async function getBuyerStats(mandateId: string, buyerName: string, deps: StatsDeps = {}): Promise<BuyerStats> {
  const configured = deps.clickhouse?.configured ?? clickhouseConfigured();
  let core: BuyerStatsCore | null = null;
  let stream: StatsStream | null = null;
  let clickhouse: InfraStatus;

  if (!configured) {
    clickhouse = { name: 'clickhouse', configured: false, ok: null, detail: 'Not configured: set AIVEN_CLICKHOUSE_URL. Stats come from Postgres.' };
  } else if (deps.forcePostgres) {
    clickhouse = { name: 'clickhouse', configured: true, ok: null, detail: 'Configured but not asked: this answer came from Postgres.' };
  } else {
    try {
      core = await chStats(mandateId, deps.clickhouse);
      let streamNote: string;
      try {
        stream = await chStream(mandateId, deps.clickhouse);
        streamNote = `${stream.events} Kafka events ingested${stream.latestAt ? `, latest ${stream.latestAt}` : ''}.`;
      } catch (err) {
        streamNote = `trade_events could not be read: ${err instanceof Error ? err.message : String(err)}`;
      }
      clickhouse = { name: 'clickhouse', configured: true, ok: true, detail: `Answered from orders_fact (loaded by the backfill script, not live). ${streamNote}` };
    } catch (err) {
      clickhouse = { name: 'clickhouse', configured: true, ok: false, detail: `${err instanceof Error ? err.message : String(err)}. This answer came from Postgres.` };
    }
  }

  const source = core ? 'clickhouse' : 'postgres';
  core ??= buildStats(await loadStatsOrders(deps.db ?? getPool(), mandateId));

  const kafka = kafkaStatus();
  if (kafka.configured && kafka.ok === null && stream && stream.events > 0) {
    kafka.ok = true;
    kafka.detail += ' Events are arriving in ClickHouse.';
  }
  return {
    mandateId,
    buyerName,
    generatedAt: new Date().toISOString(),
    source,
    ...core,
    weeks: fillWeeks(core.weeks),
    stream,
    infra: [kafka, clickhouse],
  };
}
