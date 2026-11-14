import type { ValioProductPrice } from '../types/index.ts';

// Pure: no database, no API calls. How many sales units (packs) cover an amount. Used by the one-product request flow
// and by the recipe flow, so both size an order the same way.

/** Rounds L or KG per sales unit to 2 significant figures: 19.94 L becomes 20 L, 0.497 L becomes 0.5 L. */
export const roundPackSize = (n: number) => Number(n.toPrecision(2));

export type PackUnit = 'KG' | 'L' | 'unit';

export interface PackQuantity {
  /** L or KG in one sales unit (1 when the request is counted in pieces). Null when it cannot be worked out. */
  amountPerUnit: number | null;
  /** Sales units to order, rounded up to the product's lot size. Null when `amountPerUnit` is null. */
  quantity: number | null;
  /** Why the size could not be worked out. Empty when it could. */
  reasons: string[];
}

/**
 * Pack size from the price (sales-unit price divided by the price per kilo or litre), then the number of packs that
 * cover `amount`, rounded up to a multiple of the lot size. A request in `unit` is one sales unit per piece.
 * `price` is Valio's answer for the product; without a usable comparison price in the requested unit there is no size.
 */
export function packQuantity(
  price: Pick<ValioProductPrice, 'comparisonUnit' | 'catalogPrice' | 'comparisonPrice'> | undefined,
  amount: number,
  unit: PackUnit,
  allowedLotSize: number
): PackQuantity {
  const reasons: string[] = [];
  let amountPerUnit: number | null = null;
  if (unit === 'unit') {
    amountPerUnit = 1;
  } else if (price?.comparisonUnit !== unit) {
    reasons.push(`Priced per ${price?.comparisonUnit ?? 'unknown unit'}, not per ${unit}.`);
  } else if (price.catalogPrice && price.comparisonPrice && price.comparisonPrice.value > 0) {
    amountPerUnit = roundPackSize(price.catalogPrice.value / price.comparisonPrice.value);
  } else {
    reasons.push('No price per litre or kilo to size the order with.');
  }

  let quantity: number | null = null;
  if (amountPerUnit !== null) {
    quantity = Math.ceil(amount / amountPerUnit);
    if (allowedLotSize > 1) quantity = Math.ceil(quantity / allowedLotSize) * allowedLotSize;
  }
  return { amountPerUnit, quantity, reasons };
}
