// Writes about 90 days of SYNTHETIC past orders for the two demo mandates into `order_history`, so the stats page has
// something to show. Every row is marked source = 'synthetic' by the table itself. The real `orders` table is not touched.
// Deterministic (seeded pseudo-random; dates are relative to the day of the first run) and idempotent: a mandate that
// already has history is skipped. Products come from the real catalog, so names, carbon footprints and delivery
// reliabilities are real; the order amounts and outcomes are made up.
//
//   node --conditions=react-server --env-file=.env.local scripts/seed-history.mts
import { getPool } from '../src/lib/db.ts';
import { ORDER_HISTORY_DDL } from '../src/lib/stats.ts';

const DAYS = 90;
const DAY_MS = 86_400_000;

/** Small seeded generator (mulberry32), so every run produces the same history. */
function rng(seed: string) {
  let a = [...seed].reduce((h, c) => (Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0), 2166136261);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Profile {
  id: string;
  autoLimit: number;
  maxOrder: number;
  /** Median order total (EUR) at the start and the end of the period: how the buyer's habits drift. */
  medianStart: number;
  medianEnd: number;
  sigma: number;
  weekdayOrders: [number, number];
  weekendOrders: [number, number];
  /** Share of orders under the auto limit that still need a person (a reliability or allergen rule). */
  humanShare: number;
  approveShare: number;
  /** Median seconds for a person to decide, at the start and the end. */
  decisionStart: number;
  decisionEnd: number;
  /** The buyer shifts to lower-carbon products over time. */
  greener: boolean;
}

const PROFILES: Profile[] = [
  { id: 'demo-hotel', autoLimit: 500, maxOrder: 5000, medianStart: 300, medianEnd: 460, sigma: 0.95, weekdayOrders: [1, 3], weekendOrders: [0, 1], humanShare: 0.04, approveShare: 0.86, decisionStart: 2700, decisionEnd: 1500, greener: false },
  { id: 'demo-school', autoLimit: 300, maxOrder: 2000, medianStart: 190, medianEnd: 170, sigma: 0.7, weekdayOrders: [1, 2], weekendOrders: [0, 0], humanShare: 0.08, approveShare: 0.78, decisionStart: 12000, decisionEnd: 7200, greener: true },
];

const pool = getPool();
await pool.query(ORDER_HISTORY_DDL);

const { rows: catalog } = await pool.query<{ id: string; name: string; co2: number; reliability: number }>(
  `SELECT id, COALESCE(name_en, name_fi) AS name, co2_per_kg AS co2, delivery_reliability AS reliability
   FROM products WHERE co2_per_kg IS NOT NULL AND delivery_reliability IS NOT NULL
   ORDER BY md5(id) LIMIT 60`
);
if (catalog.length < 10) throw new Error('Too few products with a carbon footprint and delivery reliability: seed the catalog first.');
catalog.sort((a, b) => a.co2 - b.co2 || (a.id < b.id ? -1 : 1));

const today = new Date();
const start = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - DAYS * DAY_MS;
const cents = (n: number) => Math.round(n * 100) / 100;

for (const p of PROFILES) {
  const { rows: existing } = await pool.query('SELECT count(*)::int AS n FROM order_history WHERE mandate_id = $1', [p.id]);
  if (existing[0].n > 0) {
    console.log(`${p.id}: ${existing[0].n} synthetic orders already there, skipped.`);
    continue;
  }
  const rand = rng(p.id);
  const normal = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const rows: unknown[] = [];

  for (let d = 0; d < DAYS; d++) {
    const t = d / (DAYS - 1);
    const day = start + d * DAY_MS;
    const weekend = [0, 6].includes(new Date(day).getUTCDay());
    const [lo, hi] = weekend ? p.weekendOrders : p.weekdayOrders;
    const count = lo + Math.floor(rand() * (hi - lo + 1));

    for (let k = 0; k < count; k++) {
      const total = cents(Math.min(Math.max(lerp(p.medianStart, p.medianEnd, t) * Math.exp(p.sigma * normal()), 25), p.maxOrder * 1.5));
      const at = new Date(day + (6 + rand() * 10) * 3_600_000);

      let outcome: string;
      let decisionSeconds: number | null = null;
      if (total > p.maxOrder) outcome = 'rejected';
      else if (total <= p.autoLimit && rand() > p.humanShare) outcome = 'auto_approved';
      else {
        outcome = rand() < p.approveShare ? 'approved' : 'declined';
        decisionSeconds = Math.round(lerp(p.decisionStart, p.decisionEnd, t) * Math.exp(0.6 * normal()));
      }

      const n = 1 + Math.floor(rand() * 4);
      const picked = new Set<number>();
      while (picked.size < n) picked.add(Math.floor((p.greener ? rand() ** (1 + 2.5 * t) : rand()) * catalog.length));
      const weights = [...picked].map(() => 0.3 + rand());
      const sum = weights.reduce((a, b) => a + b, 0);
      const lines = [...picked].map((i, j) => ({ productId: catalog[i].id, name: catalog[i].name, total: cents((total * weights[j]) / sum) }));
      const chosen = [...picked].map((i) => catalog[i]);

      rows.push({
        id: `hist-${p.id}-${String(rows.length + 1).padStart(4, '0')}`,
        mandate_id: p.id,
        created_at: at.toISOString(),
        outcome,
        total,
        decision_seconds: decisionSeconds,
        avg_co2: chosen.reduce((a, c) => a + c.co2, 0) / chosen.length,
        avg_reliability: chosen.reduce((a, c) => a + c.reliability, 0) / chosen.length,
        lines,
      });
    }
  }

  await pool.query(
    `INSERT INTO order_history (id, mandate_id, created_at, outcome, total, decision_seconds, avg_co2, avg_reliability, lines)
     SELECT id, mandate_id, created_at, outcome, total, decision_seconds, avg_co2, avg_reliability, lines
     FROM jsonb_to_recordset($1::jsonb) AS x(id text, mandate_id text, created_at timestamptz, outcome text, total double precision,
       decision_seconds double precision, avg_co2 double precision, avg_reliability double precision, lines jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [JSON.stringify(rows)]
  );
  console.log(`${p.id}: wrote ${rows.length} synthetic orders over ${DAYS} days.`);
}

await pool.end();
