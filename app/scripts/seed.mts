// Creates the tables and seeds the Valio Aimo catalog plus demo mandates into Aiven.
// Safe to re-run: products are upserted and only rows without an embedding are embedded.
//
//   node --conditions=react-server --env-file=.env.local scripts/seed.mts
//
// Needs AIVEN_DATABASE_URL and GEMINI_API_KEY, and the three data files in data/.
import { readFileSync } from 'node:fs';
import { eventHash } from '../src/lib/chain.ts';
import { enableVectorExtension, getPool } from '../src/lib/db.ts';
import { embedTexts } from '../src/lib/llm.ts';
import { ORDER_HISTORY_DDL } from '../src/lib/stats.ts';

const DATA = new URL('../data/', import.meta.url);

// --- 1. Read and flatten the source files (no network) ----------------------

interface RawClassification {
  name: string;
  values?: { id: string; synkkaId?: string; unit?: string }[];
}
interface RawProduct {
  id: string;
  salesUnit: string;
  baseUnit: string;
  category?: string;
  allowedLotSize?: number;
  countryOfOrigin?: string;
  temperatureCondition?: number;
  vendorName?: string;
  units?: unknown[];
  substitutions?: { product: string; substituteProduct: string }[];
  synkkaData?: {
    gtin?: string;
    brand?: string;
    names?: { language: string; value: string }[];
    keyIngredients?: { language: string; value: string }[];
    classifications?: RawClassification[];
    nutritionalContent?: { id: string; value: number; unit: string }[];
  };
}

function readCsv(file: string): Map<string, number> {
  const lines = readFileSync(new URL(file, DATA), 'utf8').trim().split(/\r?\n/).slice(1);
  return new Map(lines.map((l) => l.split(',')).map(([id, v]) => [id, Number(v)]));
}

const reliability = readCsv('valio_aimo_junction26_delivery_reliability.csv');
const carbon = readCsv('valio_aimo_junction26_carbon_footprint.csv');
const raw: RawProduct[] = JSON.parse(
  readFileSync(new URL('valio_aimo_junction26_product_data.json', DATA), 'utf8')
);

const inLang = (texts: { language: string; value: string }[] | undefined, lang: string) =>
  texts?.find((t) => t.language === lang)?.value ?? null;

const rows = raw.map((p) => {
  const s = p.synkkaData ?? {};
  const group = (name: string) => s.classifications?.find((c) => c.name === name)?.values ?? [];
  const allergens = group('allergen');
  const nameFi = inLang(s.names, 'fi') ?? p.id;
  const nameEn = inLang(s.names, 'en');
  const claims = group('nutritionalClaim').map((v) => v.id);
  // Real labels carry a synkkaId; the rest are temperature markers.
  const labels = group('packagingMarkedLabel').filter((v) => v.synkkaId).map((v) => v.id);

  return {
    id: p.id,
    name_fi: nameFi,
    name_en: nameEn,
    brand: s.brand ?? null,
    vendor_name: p.vendorName ?? null,
    category: p.category ?? null,
    sales_unit: p.salesUnit,
    base_unit: p.baseUnit,
    allowed_lot_size: p.allowedLotSize ?? 1,
    country_of_origin: p.countryOfOrigin ?? null,
    temperature_condition: p.temperatureCondition ?? null,
    gtin: s.gtin ?? null,
    allergens_contain: allergens.filter((v) => v.unit === 'CONTAINS').map((v) => v.id),
    allergens_may_contain: allergens.filter((v) => v.unit === 'MAY_CONTAIN').map((v) => v.id),
    allergens_free_from: group('nonAllergen').map((v) => v.id),
    claims,
    labels,
    units: p.units ?? [],
    substitutes: (p.substitutions ?? []).map((x) => x.substituteProduct),
    ingredients: inLang(s.keyIngredients, 'en') ?? inLang(s.keyIngredients, 'fi'),
    nutrition: Object.fromEntries(
      (s.nutritionalContent ?? []).map((n) => [n.id, { value: n.value, unit: n.unit }])
    ),
    delivery_reliability: reliability.get(p.id) ?? null,
    co2_per_kg: carbon.get(p.id) ?? null,
    embedding_text: [nameEn, nameFi, s.brand, [...claims, ...labels].join(', ').replaceAll('_', ' ').toLowerCase()]
      .filter(Boolean)
      .join(' | '),
  };
});

console.log(`Read ${rows.length} products (${reliability.size} with reliability, ${carbon.size} with CO2).`);

// --- 2. Tables --------------------------------------------------------------

const pool = getPool();
await enableVectorExtension();
await pool.query(`
  CREATE TABLE IF NOT EXISTS products (
    id text PRIMARY KEY,
    name_fi text NOT NULL,
    name_en text,
    brand text,
    vendor_name text,
    category text,
    sales_unit text NOT NULL,
    base_unit text NOT NULL,
    allowed_lot_size double precision NOT NULL,
    country_of_origin text,
    temperature_condition integer,
    gtin text,
    allergens_contain jsonb NOT NULL,
    allergens_may_contain jsonb NOT NULL,
    allergens_free_from jsonb NOT NULL,
    claims jsonb NOT NULL,
    labels jsonb NOT NULL,
    units jsonb NOT NULL,
    substitutes jsonb NOT NULL,
    ingredients text,
    nutrition jsonb NOT NULL,
    delivery_reliability double precision,
    co2_per_kg double precision,
    embedding_text text NOT NULL,
    embedding vector(1536)
  );

  CREATE TABLE IF NOT EXISTS mandates (
    id text PRIMARY KEY,
    buyer_name text NOT NULL,
    agent_name text NOT NULL,
    auto_approve_limit_eur double precision NOT NULL,
    max_order_eur double precision NOT NULL,
    blocked_allergens jsonb NOT NULL
  );

  CREATE TABLE IF NOT EXISTS signing_keys (
    kid text PRIMARY KEY,
    private_pem text NOT NULL,
    public_pem text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  ALTER TABLE mandates ADD COLUMN IF NOT EXISTS min_delivery_reliability double precision;
  ALTER TABLE mandates ADD COLUMN IF NOT EXISTS require_confirmed_stock boolean NOT NULL DEFAULT false;
  ALTER TABLE mandates ADD COLUMN IF NOT EXISTS max_co2_per_kg double precision;
  ALTER TABLE mandates ADD COLUMN IF NOT EXISTS preferred_offer text NOT NULL DEFAULT 'cheapest';

  CREATE TABLE IF NOT EXISTS quotes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    mandate_id text NOT NULL REFERENCES mandates(id),
    delivery_date text NOT NULL,
    currency text NOT NULL,
    lines jsonb NOT NULL,
    total double precision NOT NULL,
    total_with_tax double precision NOT NULL,
    fulfillable boolean NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
  );

  ALTER TABLE quotes ADD COLUMN IF NOT EXISTS signature text;
  ALTER TABLE quotes ADD COLUMN IF NOT EXISTS signature_key_id text;

  CREATE TABLE IF NOT EXISTS orders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    quote_id uuid NOT NULL UNIQUE REFERENCES quotes(id), -- one order per quote
    mandate_id text NOT NULL REFERENCES mandates(id),
    status text NOT NULL,
    policy_reasons jsonb NOT NULL,
    delivery_date text NOT NULL,
    currency text NOT NULL,
    lines jsonb NOT NULL,
    total double precision NOT NULL,
    total_with_tax double precision NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    decided_by text,
    decided_at timestamptz,
    decision_note text
  );

  CREATE TABLE IF NOT EXISTS verifications (
    product_id text PRIMARY KEY REFERENCES products(id),
    checked_at timestamptz NOT NULL DEFAULT now(),
    status text NOT NULL,
    statements jsonb NOT NULL,
    contradictions jsonb NOT NULL,
    sources jsonb NOT NULL,
    search_request_id text,
    summary text NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_events (
    id bigserial PRIMARY KEY,
    at timestamptz NOT NULL DEFAULT now(),
    actor text NOT NULL,
    action text NOT NULL,
    mandate_id text,
    quote_id uuid,
    order_id uuid,
    summary text NOT NULL,
    data jsonb NOT NULL
  );
  ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS prev_hash text;
  ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS hash text;
`);
await pool.query(ORDER_HISTORY_DDL); // synthetic demo history for /stats, filled by scripts/seed-history.mts

// Events written before the hash chain existed get hashed now, oldest first, so one chain covers the whole trail.
{
  const { rows } = await pool.query(
    'SELECT * FROM audit_events WHERE hash IS NULL ORDER BY id ASC'
  );
  const { rows: before } = await pool.query(
    `SELECT hash FROM audit_events WHERE hash IS NOT NULL ORDER BY id DESC LIMIT 1`
  );
  let prev: string | null = before[0]?.hash ?? null;
  for (const r of rows) {
    const hash = eventHash(prev, {
      at: new Date(r.at).toISOString(),
      actor: r.actor,
      action: r.action,
      mandateId: r.mandate_id,
      quoteId: r.quote_id,
      orderId: r.order_id,
      summary: r.summary,
      data: r.data,
    });
    await pool.query('UPDATE audit_events SET prev_hash = $2, hash = $3 WHERE id = $1', [r.id, prev, hash]);
    prev = hash;
  }
  if (rows.length) console.log(`Hash-chained ${rows.length} earlier audit events.`);
}

// --- 3. Products ------------------------------------------------------------

const TEXT_COLS = ['id', 'name_fi', 'name_en', 'brand', 'vendor_name', 'category', 'sales_unit', 'base_unit',
  'country_of_origin', 'gtin', 'ingredients', 'embedding_text'];
const JSON_COLS = ['allergens_contain', 'allergens_may_contain', 'allergens_free_from', 'claims', 'labels',
  'units', 'substitutes', 'nutrition'];
const NUM_COLS = ['allowed_lot_size', 'delivery_reliability', 'co2_per_kg'];
const cols = [...TEXT_COLS, ...JSON_COLS, ...NUM_COLS, 'temperature_condition'];
const recordDef = [
  ...TEXT_COLS.map((c) => `${c} text`),
  ...JSON_COLS.map((c) => `${c} jsonb`),
  ...NUM_COLS.map((c) => `${c} double precision`),
  'temperature_condition integer',
].join(', ');

for (let i = 0; i < rows.length; i += 500) {
  // The embedding is left alone on conflict, so a re-run does not throw away paid-for vectors.
  await pool.query(
    `INSERT INTO products (${cols.join(', ')})
     SELECT ${cols.join(', ')} FROM jsonb_to_recordset($1::jsonb) AS x(${recordDef})
     ON CONFLICT (id) DO UPDATE SET ${cols.filter((c) => c !== 'id').map((c) => `${c} = EXCLUDED.${c}`).join(', ')}`,
    [JSON.stringify(rows.slice(i, i + 500))]
  );
}
console.log(`Upserted ${rows.length} products.`);

// --- 4. Demo mandates -------------------------------------------------------

// Re-running the seed resets these two mandates to their defaults.
await pool.query(
  `INSERT INTO mandates (id, buyer_name, agent_name, auto_approve_limit_eur, max_order_eur, blocked_allergens,
                         min_delivery_reliability, require_confirmed_stock, max_co2_per_kg, preferred_offer)
   VALUES ('demo-hotel', 'Nordic Hotel Group (demo)', 'Hotel purchasing agent', 500, 5000, '[]', NULL, false, NULL, 'cheapest'),
          ('demo-school', 'City School Kitchens (demo)', 'School kitchen agent', 300, 2000, '["AN", "AP"]', 0.9, true, 5, 'most_reliable')
   ON CONFLICT (id) DO UPDATE SET
     buyer_name = EXCLUDED.buyer_name, agent_name = EXCLUDED.agent_name,
     auto_approve_limit_eur = EXCLUDED.auto_approve_limit_eur, max_order_eur = EXCLUDED.max_order_eur,
     blocked_allergens = EXCLUDED.blocked_allergens, min_delivery_reliability = EXCLUDED.min_delivery_reliability,
     require_confirmed_stock = EXCLUDED.require_confirmed_stock, max_co2_per_kg = EXCLUDED.max_co2_per_kg,
     preferred_offer = EXCLUDED.preferred_offer`
);

// --- 5. Embeddings (resumable) ----------------------------------------------

// `--no-embed` stops after the tables, products and mandates: use it to apply schema changes without
// spending embedding quota.
if (process.argv.includes('--no-embed')) {
  console.log('Done (embeddings skipped).');
  await pool.end();
  process.exit(0);
}

// Gemini's free tier allows 1000 embedded texts per DAY (and 100 per minute), so the full catalog cannot
// be embedded on it. The batch is 50 a minute so a running app keeps quota for its own search queries.
// Search falls back to keyword-only when embeddings are unavailable.
const BATCH = 50;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (;;) {
  const started = Date.now();
  const { rows: batch } = await pool.query<{ id: string; embedding_text: string }>(
    'SELECT id, embedding_text FROM products WHERE embedding IS NULL ORDER BY id LIMIT $1',
    [BATCH]
  );
  if (batch.length === 0) break;

  let vectors: number[][];
  try {
    vectors = await embedTexts(batch.map((b) => b.embedding_text));
  } catch (err) {
    if ((err as { status?: number }).status !== 429) throw err;
    console.log(`${new Date().toLocaleTimeString('en-GB')} Gemini rate limit hit, waiting 60 s...`);
    await sleep(60_000);
    continue;
  }

  await pool.query(
    `UPDATE products p SET embedding = x.e::vector
     FROM jsonb_to_recordset($1::jsonb) AS x(id text, e text) WHERE p.id = x.id`,
    [JSON.stringify(batch.map((b, i) => ({ id: b.id, e: `[${vectors[i].join(',')}]` })))]
  );
  const { rows: left } = await pool.query('SELECT count(*)::int AS n FROM products WHERE embedding IS NULL');
  console.log(`${new Date().toLocaleTimeString('en-GB')} embedded ${batch.length}, ${left[0].n} left.`);
  if (left[0].n > 0) await sleep(Math.max(0, 60_000 - (Date.now() - started)));
}

console.log('Done.');
await pool.end();
