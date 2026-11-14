import type { ApiError } from '@/types';

const APPROVER_KEY = 'approver-key';

const storedApproverKey = () => {
  try {
    return sessionStorage.getItem(APPROVER_KEY);
  } catch {
    return null;
  }
};

/**
 * JSON call to our own API. Throws the API's error message so the UI can show it in a banner.
 * Approving, deciding and editing a mandate need the approver key: it is asked for once when the server answers 401,
 * kept for this browser tab only, and sent on later calls.
 */
export async function call<T>(url: string, body?: unknown, method?: 'POST' | 'PATCH'): Promise<T> {
  const send = (key: string | null) =>
    fetch(url, {
      method: method ?? (body ? 'POST' : 'GET'),
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });

  let res: Response;
  try {
    res = await send(storedApproverKey());
    if (res.status === 401 && res.headers.get('www-authenticate')?.includes('approver') && typeof window !== 'undefined') {
      const entered = window.prompt('Approver key')?.trim();
      if (entered) {
        try {
          sessionStorage.setItem(APPROVER_KEY, entered);
        } catch {
          // storage unavailable: the key is used for this call only
        }
        res = await send(entered);
      }
    }
  } catch {
    throw new Error('Could not reach the server.');
  }

  // Read as text first: a gateway timeout or error page is HTML, and res.json() would show a raw parse error.
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(
      [502, 503, 504].includes(res.status) ? 'The server took too long or is unavailable. Try again.' : `HTTP ${res.status}`
    );
  }
  if (!res.ok) throw new Error((json as ApiError | null)?.error ?? `HTTP ${res.status}`);
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
