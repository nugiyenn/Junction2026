import 'server-only';
import { cached, valioKey } from './cache.ts';
import type { ValioAvailabilityResponse, ValioPriceResponse } from '../types/index.ts';

const BASE_URL = 'https://junction26.valioaimo.fi';

/** The mock ignores the customer number, but the field is required. */
const DEFAULT_CUSTOMER = '123';

/**
 * Cache lifetimes (Aiven Valkey). Prices are agreed per customer and move on a scale of days, so 30 s
 * only collapses the burst of identical lookups one buying request makes (planning, then the quote).
 * Availability moves as other buyers reserve stock, so it gets half that. Neither makes an order
 * wrong: `placeOrder` never calls Valio, and a quote holds the prices it was signed with. The cost
 * is that a quote can show stock up to 15 s old, which is why Valio still has the last word on delivery.
 */
const PRICE_TTL_S = 30;
const AVAILABILITY_TTL_S = 15;

async function valioFetch<T>(path: string, body?: unknown): Promise<T> {
  const apiKey = process.env.VALIO_API_KEY;
  if (!apiKey) throw new Error('Missing VALIO_API_KEY: cannot call valio');

  const response = await fetch(`${BASE_URL}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'X-API-Key': apiKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(`Valio error (${response.status}) on ${path}: ${(await response.text()).slice(0, 500)}`);
  }
  return response.json() as Promise<T>;
}

export function pingValio(): Promise<unknown> {
  return valioFetch('/api/ping');
}

/**
 * Prices per sales unit for 1-1000 product codes on a delivery date (YYYY-MM-DD). Cached for 30 s.
 * Rate limited: only call it for products already narrowed down from the static catalog.
 */
export function getPrices(productIds: string[], requestedDate: string, customer = DEFAULT_CUSTOMER) {
  return cached(valioKey('price', customer, requestedDate, productIds), PRICE_TTL_S, () =>
    valioFetch<ValioPriceResponse>('/api/price', { customer, requestedDate, products: productIds })
  );
}

/**
 * Availability for 1-1000 product codes on a delivery date (YYYY-MM-DD).
 * Cached for 15 s. An empty `scheduleLines` means the product cannot be delivered on any date.
 */
export function getAvailability(productIds: string[], requestedDate: string, customer = DEFAULT_CUSTOMER) {
  return cached(valioKey('availability', customer, requestedDate, productIds), AVAILABILITY_TTL_S, () =>
    valioFetch<ValioAvailabilityResponse>('/api/availability', { customer, requestedDate, products: productIds })
  );
}
