import type { ApiError } from '@/types';

/** JSON call to our own API. Throws the API's error message so the UI can show it in a banner. */
export async function call<T>(url: string, body?: unknown, method?: 'POST' | 'PATCH'): Promise<T> {
  const res = await fetch(url, {
    method: method ?? (body ? 'POST' : 'GET'),
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error((json as ApiError).error ?? `HTTP ${res.status}`);
  return json as T;
}

export const eur = (n: number | null | undefined) =>
  n === null || n === undefined
    ? '–'
    : `€${n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const clock = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/** GS1 allergen codes, as used in the catalog. Unknown codes are shown as they are. */
export const ALLERGEN_LABELS: Record<string, string> = {
  AM: 'Milk',
  AE: 'Eggs',
  AF: 'Fish',
  AN: 'Tree nuts',
  AP: 'Peanuts',
  AS: 'Sesame',
  AY: 'Soy',
  AC: 'Crustaceans',
  AW: 'Gluten cereals',
  BC: 'Celery',
  BM: 'Mustard',
  AU: 'Sulphites',
};

export const allergenName = (code: string) => (ALLERGEN_LABELS[code] ? `${ALLERGEN_LABELS[code]} (${code})` : code);
