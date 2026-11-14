import { z } from 'zod';
import type { PurchaseRequest } from '../types/index.ts';

/** The request-reading prompt and schema, kept free of server imports so the evaluation script can run the very same ones. */

export const CLAIMS = [
  'FREE_FROM_LACTOSE', 'LOW_LACTOSE', 'FREE_FROM_GLUTEN', 'VEGAN', 'VEGETARIAN', 'FREE_FROM_EGGS',
  'FREE_FROM_SOY', 'FREE_FROM_WHEAT', 'NO_ADDED_SUGARS', 'LOW_FAT', 'FREE_FROM_FAT', 'HIGH_PROTEIN',
  'LOW_SODIUM_SALT', 'FREE_FROM_PRESERVATIVES', 'FREE_FROM_ADDITIVES',
] as const;

export const PurchaseRequestSchema = z.object({
  product: z.string().min(1),
  amount: z.number().positive(),
  amountUnit: z.enum(['L', 'KG', 'unit']),
  deliveryDate: z.iso.date(),
  requiredClaims: z.array(z.enum(CLAIMS)),
}) satisfies z.ZodType<PurchaseRequest>;

/** Today in Helsinki as YYYY-MM-DD plus the weekday, so relative dates like "by Monday" resolve correctly. */
export function helsinkiToday(): { date: string; weekday: string } {
  const now = new Date();
  const date = now.toLocaleDateString('sv-SE', { timeZone: 'Europe/Helsinki' });
  const weekday = now.toLocaleDateString('en-GB', { timeZone: 'Europe/Helsinki', weekday: 'long' });
  return { date, weekday };
}

const WEEKDAYS: [string, number][] = [
  ['monday', 1], ['tuesday', 2], ['wednesday', 3], ['thursday', 4], ['friday', 5], ['saturday', 6], ['sunday', 0],
  ['maanantai', 1], ['tiistai', 2], ['keskiviikko', 3], ['torstai', 4], ['perjantai', 5], ['lauantai', 6], ['sunnuntai', 0],
];

/** A written-out date ("20.11.", "2026-11-20", "20 November"): then the weekday is a hint, not the date. */
const EXPLICIT_DATE = /\d{4}-\d{2}-\d{2}|\d{1,2}[./]\d{1,2}\b|\b\d{1,2}(st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;

/**
 * The date a weekday name in the request means: the first weekday mentioned, counted as the next one strictly after
 * today ("by Monday" on a Saturday is two days away). English and Finnish names, inflections included
 * ("maanantaiksi"). Null when the request names no weekday or gives an explicit date.
 * Date arithmetic is code's job: in the evaluation one model was a day late on every weekday request.
 */
export function weekdayDate(text: string, todayIso: string): string | null {
  if (EXPLICIT_DATE.test(text)) return null;
  const lower = text.toLowerCase();
  const first = WEEKDAYS.map(([name, day]) => ({ at: lower.indexOf(name), day }))
    .filter((w) => w.at >= 0)
    .sort((a, b) => a.at - b.at)[0];
  if (!first) return null;
  const date = new Date(`${todayIso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + ((first.day - date.getUTCDay() + 6) % 7) + 1);
  return date.toISOString().slice(0, 10);
}

/**
 * What differs between two readings of the same request, on the fields code relies on: the amount it multiplies, the unit
 * and the delivery date. Empty when they agree. The product text and the diet claims may be worded differently, so they
 * are not compared.
 */
export function compareInterpretations(first: PurchaseRequest, second: PurchaseRequest): string[] {
  const differences: string[] = [];
  if (Math.abs(first.amount - second.amount) > 1e-9 * Math.max(first.amount, second.amount)) {
    differences.push(`amount: ${first.amount} vs ${second.amount}`);
  }
  if (first.amountUnit !== second.amountUnit) differences.push(`unit: ${first.amountUnit} vs ${second.amountUnit}`);
  if (first.deliveryDate !== second.deliveryDate) differences.push(`delivery date: ${first.deliveryDate} vs ${second.deliveryDate}`);
  return differences;
}

export function interpretInstructions(today: { date: string; weekday: string }): string {
  return `You turn a food-service buyer's purchase request into JSON with exactly these fields:
- "product": short English description of the product to search for, without diet words (e.g. "milk", "butter").
- "amount": the number requested.
- "amountUnit": "L" for litres/decilitres (convert dl to L), "KG" for kilograms/grams (convert g to KG), otherwise "unit".
- "deliveryDate": YYYY-MM-DD. Today is ${today.weekday} ${today.date}. "By Monday" means the next Monday after today.
- "requiredClaims": diet claims the product must carry, only from this list: ${CLAIMS.join(', ')}. Empty array if none.`;
}
