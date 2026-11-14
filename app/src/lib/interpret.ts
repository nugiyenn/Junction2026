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

export function interpretInstructions(today: { date: string; weekday: string }): string {
  return `You turn a food-service buyer's purchase request into JSON with exactly these fields:
- "product": short English description of the product to search for, without diet words (e.g. "milk", "butter").
- "amount": the number requested.
- "amountUnit": "L" for litres/decilitres (convert dl to L), "KG" for kilograms/grams (convert g to KG), otherwise "unit".
- "deliveryDate": YYYY-MM-DD. Today is ${today.weekday} ${today.date}. "By Monday" means the next Monday after today.
- "requiredClaims": diet claims the product must carry, only from this list: ${CLAIMS.join(', ')}. Empty array if none.`;
}
