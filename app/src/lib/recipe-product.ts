import { sanitizeIssue, stockView } from './exposure.ts';
import type { PackQuantity } from './packs.ts';
import type { Product, QuoteLine, RecipeProduct, RecipeUnit } from '../types/index.ts';

// Pure. The one place a quote line becomes what the recipe screen shows: named fields only, so Valio's internal data
// (list price, discount, supplier, category, exact stock) cannot ride along by accident.

/** The sizing reasons from packQuantity, in words a buyer follows. */
const plainReason = (reason: string) =>
  /^Priced per unknown unit|^No price per litre or kilo/.test(reason) ? 'Valio has no price per kilo or litre for this product, so the packs cannot be worked out.' : reason;

/** `unit` is the unit the pack size is in (the line's own, or the price's when kilos were counted as litres). */
export function toRecipeProduct(
  product: Pick<Product, 'id' | 'brand' | 'gtin'>,
  line: QuoteLine,
  pack: PackQuantity,
  unit: RecipeUnit
): RecipeProduct {
  const issues = [...pack.reasons.map(plainReason), ...(pack.quantity !== null ? line.issues : [])].map(sanitizeIssue);
  return {
    productId: product.id,
    name: line.name,
    brand: product.brand,
    gtin: product.gtin,
    salesUnit: line.salesUnit,
    packSize: pack.amountPerUnit,
    packUnit: pack.amountPerUnit === null ? null : unit,
    quantity: pack.quantity,
    unitPrice: line.unitPrice,
    lineTotal: pack.quantity === null ? null : line.lineTotal,
    fulfillable: pack.quantity !== null && line.fulfillable,
    issues,
    stock: stockView(line),
  };
}
