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

/** Semantic search over the static catalog, narrowed by SQL filters. No prices or stock. */
export async function searchProducts(
  query: string,
  filters: ProductFilters = {},
  limit = 10
): Promise<ProductSearchResult[]> {
  const where = ['embedding IS NOT NULL'];
  const params: unknown[] = [];
  const next = (value: unknown) => `$${params.push(value) + 2}`; // $1 and $2 belong to vectorSearch

  if (filters.claims?.length) where.push(`claims @> ${next(JSON.stringify(filters.claims))}::jsonb`);
  if (filters.labels?.length) where.push(`labels @> ${next(JSON.stringify(filters.labels))}::jsonb`);
  if (filters.excludeAllergens?.length) {
    const p = next(filters.excludeAllergens);
    where.push(`NOT (allergens_contain ?| ${p}::text[]) AND NOT (allergens_may_contain ?| ${p}::text[])`);
  }

  const rows = await vectorSearch<ProductRow>('products', await embedText(query), limit, where.join(' AND '), params);
  return rows.map((r) => ({ ...toProduct(r), similarity: Number(r.similarity) }));
}

export async function getProductsByIds(ids: string[]): Promise<Map<string, Product>> {
  const { rows } = await getPool().query<ProductRow>('SELECT * FROM products WHERE id = ANY($1::text[])', [ids]);
  return new Map(rows.map((r) => [r.id, toProduct(r)]));
}
