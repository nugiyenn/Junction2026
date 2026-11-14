// Writes 26 weeks of SYNTHETIC standing orders for the two demo mandates into `order_history`, so the "unusual order"
// check has a baseline: demo-hotel orders 1,000 L skimmed milk every Monday plus weekly cream and butter every second
// week; demo-school orders oat drink and a granola every Tuesday. Each line carries the product id, the pack count and the
// amount in litres or kilos, which is what the check reads. A few weeks vary for good reasons (a holiday week at +20%, a
// summer dip) so the rule can show that it does not flag them.
//
// Every row is marked source = 'synthetic' by the table itself; the real `orders` table is not touched. Deterministic
// (seeded pseudo-random, fixed delivery dates) and idempotent (deterministic ids, ON CONFLICT DO NOTHING). Only INSERTs
// into `order_history`; no schema change.
//
//   node --conditions=react-server --env-file=.env.local scripts/seed-standing-orders.mts [--replace]
//
// The hotel's milk is Valio skimmed milk 1 l ESL (469477), not the 10 l novobox (460396): the mock's fixed order cut-off
// for the novobox has passed, so it cannot be quoted today and the demo orders could not use it.
import { getPool } from '../src/lib/db.ts';
import { ORDER_HISTORY_DDL } from '../src/lib/stats.ts';

const WEEKS = 26;
const DAY_MS = 86_400_000;
/** The Monday of the newest standing order (the week before the demo was prepared). Older weeks count back from it. */
const LAST_MONDAY = Date.UTC(2026, 10, 9);

/** Small seeded generator (mulberry32), so every run produces the same history. */
function rng(seed: string) {
  let a = [...seed].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Standing {
  productId: string;
  /** What the product costs per pack (ex VAT) and how much a pack holds, as the Valio mock priced them. */
  unitPrice: number;
  perPack: number;
  unit: 'L' | 'KG';
  /** Usual packs per delivery. */
  packs: number;
  /** Every n-th week, counting from the newest. */
  everyWeeks: number;
  /** Before the newest 12 weeks: this share of weeks is exactly the usual quantity, the rest is off by 3 to 5 %. */
  exactShare: number;
}

interface Profile {
  id: string;
  /** 1 = Monday, 2 = Tuesday: the delivery weekday. */
  weekday: number;
  /** Week numbers (0 = newest) with a legitimate +20 %, and with a summer dip and its factor. */
  holidayWeeks: number[];
  dipWeeks: number[];
  dipFactor: number;
  standing: Standing[];
}

const PROFILES: Profile[] = [
  {
    id: 'demo-hotel',
    weekday: 1,
    holidayWeeks: [4, 22],
    dipWeeks: [17, 18, 19],
    dipFactor: 0.85,
    standing: [
      { productId: '469477', unitPrice: 0.88, perPack: 1, unit: 'L', packs: 1000, everyWeeks: 1, exactShare: 0.4 }, // skimmed milk 1 l
      { productId: '464249', unitPrice: 2.63, perPack: 1, unit: 'L', packs: 30, everyWeeks: 1, exactShare: 0.3 }, // cooking cream 15 % 1 l
      { productId: '464411', unitPrice: 3.3, perPack: 0.5, unit: 'KG', packs: 40, everyWeeks: 2, exactShare: 0.3 }, // butter 500 g
    ],
  },
  {
    id: 'demo-school',
    weekday: 2,
    holidayWeeks: [10],
    dipWeeks: [16, 17, 18, 19],
    dipFactor: 0.4,
    standing: [
      { productId: '468465', unitPrice: 1.17, perPack: 1, unit: 'L', packs: 120, everyWeeks: 1, exactShare: 0.3 }, // oat drink 1 l
      { productId: '467857', unitPrice: 3.66, perPack: 0.35, unit: 'KG', packs: 57, everyWeeks: 1, exactShare: 0.3 }, // granola 350 g, free from nuts: about 20 kg a week, like the 'School, 20 kg granola' demo scenario
    ],
  },
];

const pool = getPool();
await pool.query(ORDER_HISTORY_DDL);

const ids = PROFILES.flatMap((p) => p.standing.map((s) => s.productId));
const { rows: catalog } = await pool.query<{ id: string; name: string; co2: number | null; reliability: number | null }>(
  `SELECT id, COALESCE(name_en, name_fi) AS name, co2_per_kg AS co2, delivery_reliability AS reliability FROM products WHERE id = ANY($1::text[])`,
  [ids]
);
const product = new Map(catalog.map((c) => [c.id, c]));
for (const id of ids) if (!product.has(id)) throw new Error(`Product ${id} is not in the catalog: seed the catalog first.`);

const cents = (n: number) => Math.round(n * 100) / 100;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

// --replace: delete this script's own rows first (ids standing-<mandate>-<date>) and write them again. Use it after changing a profile.
const replace = process.argv.includes('--replace');

for (const p of PROFILES) {
  const rand = rng(`standing-${p.id}`);
  const rows: unknown[] = [];
  if (replace) {
    const del = await pool.query(`DELETE FROM order_history WHERE mandate_id = $1 AND id LIKE $2`, [p.id, `standing-${p.id}-%`]);
    console.log(`${p.id}: ${del.rowCount} earlier standing orders removed.`);
  }

  for (let w = WEEKS - 1; w >= 0; w--) {
    const delivery = LAST_MONDAY - w * 7 * DAY_MS + (p.weekday - 1) * DAY_MS;
    const lines = [];
    for (const s of p.standing) {
      if (w % s.everyWeeks !== 0) continue;
      let factor = 1;
      const roll = rand();
      const size = 0.03 + rand() * 0.02;
      if (p.holidayWeeks.includes(w)) factor = 1.2;
      else if (p.dipWeeks.includes(w)) factor = p.dipFactor;
      else if (w < 12) {
        // The newest 12 weeks are what the check reads: every other week is exactly the usual quantity and the rest are 3 to 5 %
        // off with alternating signs, so the median is exactly the usual quantity and the demo orders have a clean reference.
        if (w % 2 === 0) factor = 1 + (w % 4 === 0 ? 1 : -1) * size;
      } else if (roll >= s.exactShare) factor = 1 + (rand() < 0.5 ? -1 : 1) * size;
      const packs = Math.max(1, Math.round(s.packs * factor));
      const c = product.get(s.productId)!;
      lines.push({
        productId: s.productId,
        name: c.name,
        quantity: packs,
        salesUnit: 'ST',
        amount: cents(packs * s.perPack),
        unit: s.unit,
        total: cents(packs * s.unitPrice),
        deliveryDate: iso(delivery),
        synthetic: true,
      });
    }
    const total = cents(lines.reduce((sum, l) => sum + l.total, 0));
    const chosen = lines.map((l) => product.get(l.productId)!);
    const autoLimit = p.id === 'demo-hotel' ? 500 : 300;
    const auto = total <= autoLimit;
    rows.push({
      id: `standing-${p.id}-${iso(delivery)}`,
      mandate_id: p.id,
      // Placed on the Thursday before delivery, mid-morning.
      created_at: new Date(delivery - 4 * DAY_MS + (9 + rand() * 3) * 3_600_000).toISOString(),
      outcome: auto ? 'auto_approved' : 'approved',
      total,
      decision_seconds: auto ? null : Math.round(900 + rand() * 1800),
      avg_co2: mean(chosen.flatMap((c) => (c.co2 === null ? [] : [c.co2]))),
      avg_reliability: mean(chosen.flatMap((c) => (c.reliability === null ? [] : [c.reliability]))),
      lines,
    });
  }

  const result = await pool.query(
    `INSERT INTO order_history (id, mandate_id, created_at, outcome, total, decision_seconds, avg_co2, avg_reliability, lines)
     SELECT id, mandate_id, created_at, outcome, total, decision_seconds, avg_co2, avg_reliability, lines
     FROM jsonb_to_recordset($1::jsonb) AS x(id text, mandate_id text, created_at timestamptz, outcome text, total double precision,
       decision_seconds double precision, avg_co2 double precision, avg_reliability double precision, lines jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [JSON.stringify(rows)]
  );
  console.log(`${p.id}: ${result.rowCount} of ${rows.length} synthetic standing orders written (the rest were already there).`);
}

await pool.end();
