import 'server-only';
import type { ValioAvailabilityResponse, ValioPriceResponse } from '@/types';

const BASE_URL = 'https://junction26.valioaimo.fi';

/** The mock ignores the customer number, but the field is required. */
const DEFAULT_CUSTOMER = '123';

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
 * Prices per sales unit for 1-1000 product codes on a delivery date (YYYY-MM-DD).
 * Rate limited: only call it for products already narrowed down from the static catalog.
 */
export function getPrices(productIds: string[], requestedDate: string, customer = DEFAULT_CUSTOMER) {
  return valioFetch<ValioPriceResponse>('/api/price', { customer, requestedDate, products: productIds });
}

/**
 * Availability for 1-1000 product codes on a delivery date (YYYY-MM-DD).
 * An empty `scheduleLines` means the product cannot be delivered on any date.
 */
export function getAvailability(productIds: string[], requestedDate: string, customer = DEFAULT_CUSTOMER) {
  return valioFetch<ValioAvailabilityResponse>('/api/availability', { customer, requestedDate, products: productIds });
}
