import 'server-only';
import { getPool, vectorSearch } from '@/lib/db';
import { embedText } from '@/lib/llm';
import type { Product, ProductSearchResult } from '@/types';

interface ProductRow {
  id: string;
  name_fi: string;
  name_en: string | null;
  brand: string | null;
  vendor_name: string | null;
  category: string | null;
  sales_unit: string;
  base_unit: string;
  allowed_lot_size: number;
  country_of_origin: string | null;
  temperature_condition: number | null;
  gtin: string | null;
  allergens_contain: string[];
  allergens_may_contain: string[];
  allergens_free_from: string[];
  claims: string[];
  labels: string[];
  units: Product['units'];
  substitutes: string[];
  ingredients: string | null;
  nutrition: Product['nutrition'];
  delivery_reliability: number | null;
  co2_per_kg: number | null;
  [column: string]: unknown;
}

function toProduct(r: ProductRow): Product {
  return {
    id: r.id,
    nameFi: r.name_fi,
    nameEn: r.name_en,
    brand: r.brand,
    vendorName: r.vendor_name,
    category: r.category,
    salesUnit: r.sales_unit,
    baseUnit: r.base_unit,
    allowedLotSize: r.allowed_lot_size,
    countryOfOrigin: r.country_of_origin,
    temperatureCondition: r.temperature_condition,
    gtin: r.gtin,
    allergensContain: r.allergens_contain,
    allergensMayContain: r.allergens_may_contain,
    allergensFreeFrom: r.allergens_free_from,
    claims: r.claims,
    labels: r.labels,
    units: r.units,
    substitutes: r.substitutes,
    ingredients: r.ingredients,
    nutrition: r.nutrition,
    deliveryReliability: r.delivery_reliability,
    co2PerKg: r.co2_per_kg,
  };
}

export interface ProductFilters {
  /** Every claim must be present, e.g. ['FREE_FROM_LACTOSE']. */
  claims?: string[];
  /** Every label must be present, e.g. ['EU_ORGANIC_FARMING']. */
  labels?: string[];
  /** Drops products that contain or may contain any of these allergen codes. */
  excludeAllergens?: string[];
}

/** SQL filter shared by both searches. Values start at `$firstParam` so each search can put its own params first. */
function filterSql(filters: ProductFilters, firstParam: number): { sql: string[]; params: unknown[] } {
  const sql: string[] = [];
  const params: unknown[] = [];
  const next = (value: unknown) => `$${params.push(value) + firstParam - 1}`;

  if (filters.claims?.length) sql.push(`claims @> ${next(JSON.stringify(filters.claims))}::jsonb`);
  if (filters.labels?.length) sql.push(`labels @> ${next(JSON.stringify(filters.labels))}::jsonb`);
  if (filters.excludeAllergens?.length) {
    const p = next(filters.excludeAllergens);
    sql.push(`NOT (allergens_contain ?| ${p}::text[]) AND NOT (allergens_may_contain ?| ${p}::text[])`);
  }
  return { sql, params };
}

/** How many results each search contributes before fusion. */
const POOL = 50;

/**
 * Hybrid search over the static catalog: keyword (Postgres full-text on names, brand and claims) and
 * semantic (pgvector) results, merged with reciprocal rank fusion and narrowed by the same SQL filters.
 * Keyword search also covers products whose embedding hasn't been computed yet. No prices or stock.
 * `similarity` is the fused score: higher is better, comparable only within one result list.
 */
export async function searchProducts(
  query: string,
  filters: ProductFilters = {},
  limit = 10,
  /** Extra keyword terms matched as word prefixes (`term:*`), for languages with endings and compounds. The meaning search ignores them. */
  prefixTerms: string[] = []
): Promise<{ products: ProductSearchResult[]; semantic: boolean; excludedByAllergens: number }> {
  const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0) return { products: [], semantic: false, excludedByAllergens: 0 };
  const tsQuery = [...words, ...prefixTerms.flatMap((t) => t.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map((t) => `${t}:*`)].join(' | ');

  // Keyword: any word may match, ranked by how well.
  const keywordFilter = filterSql(filters, 3);
  const { rows: keywordRows } = await getPool().query<ProductRow>(
    `SELECT * FROM products
     WHERE to_tsvector('simple', embedding_text) @@ to_tsquery('simple', $1)
     ${keywordFilter.sql.map((s) => `AND ${s}`).join(' ')}
     ORDER BY ts_rank(to_tsvector('simple', embedding_text), to_tsquery('simple', $1)) DESC, id
     LIMIT $2`,
    [tsQuery, POOL, ...keywordFilter.params]
  );

  // How many keyword matches the allergen filter removed, so the buyer can see what the mandate hid.
  let excludedByAllergens = 0;
  if (filters.excludeAllergens?.length) {
    const rest = filterSql({ claims: filters.claims, labels: filters.labels }, 2);
    const allergenParam = `$${rest.params.length + 2}`;
    const { rows } = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM products
       WHERE to_tsvector('simple', embedding_text) @@ to_tsquery('simple', $1)
       ${rest.sql.map((s) => `AND ${s}`).join(' ')}
       AND (allergens_contain ?| ${allergenParam}::text[] OR allergens_may_contain ?| ${allergenParam}::text[])`,
      [tsQuery, ...rest.params, filters.excludeAllergens]
    );
    excludedByAllergens = rows[0].n;
  }

  // Semantic: only products that already have an embedding. If embedding the query fails (for example
  // Gemini's free daily quota), keyword results still answer, and the caller is told `semantic: false`.
  let vectorRows: ProductRow[] = [];
  let semantic = true;
  try {
    const vectorFilter = filterSql(filters, 3); // $1 and $2 belong to vectorSearch
    vectorRows = await vectorSearch<ProductRow>(
      'products',
      await embedText(query),
      POOL,
      ['embedding IS NOT NULL', ...vectorFilter.sql].join(' AND '),
      vectorFilter.params
    );
  } catch (err) {
    semantic = false;
    console.warn('Semantic search unavailable, using keyword search only:', (err as Error).message.slice(0, 160));
  }

  // Reciprocal rank fusion: a product ranked high by either search, or by both, comes first.
  const fused = new Map<string, { row: ProductRow; score: number }>();
  for (const list of [keywordRows, vectorRows]) {
    list.forEach((row, rank) => {
      const entry = fused.get(row.id) ?? { row, score: 0 };
      entry.score += 1 / (60 + rank);
      fused.set(row.id, entry);
    });
  }

  const products = [...fused.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ row, score }) => {
      delete row.embedding;
      return { ...toProduct(row), similarity: Number(score.toFixed(4)) };
    });
  return { products, semantic, excludedByAllergens };
}

export async function getProductsByIds(ids: string[]): Promise<Map<string, Product>> {
  const { rows } = await getPool().query<ProductRow>('SELECT * FROM products WHERE id = ANY($1::text[])', [ids]);
  return new Map(rows.map((r) => [r.id, toProduct(r)]));
}

/** Every word of the catalog's names and descriptions (lowercase, four letters or more), kept for an hour. For splitting Finnish compounds. */
let vocabulary: { at: number; words: Promise<Set<string>> } | null = null;
export function catalogVocabulary(): Promise<Set<string>> {
  if (!vocabulary || Date.now() - vocabulary.at > 3_600_000) {
    const words = getPool()
      .query<{ word: string }>(
        `SELECT word FROM ts_stat($$SELECT to_tsvector('simple', embedding_text) FROM products$$) WHERE length(word) >= 4 AND word !~ '[0-9]'`
      )
      .then(({ rows }) => new Set(rows.map((r) => r.word)));
    words.catch(() => {
      vocabulary = null;
    });
    vocabulary = { at: Date.now(), words };
  }
  return vocabulary.words;
}
