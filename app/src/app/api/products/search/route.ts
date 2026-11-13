import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { logAudit } from '@/lib/audit';
import { searchProducts } from '@/lib/catalog';
import { errorResponse } from '@/lib/http';

const csv = z
  .string()
  .optional()
  .transform((s) => s?.split(',').map((v) => v.trim()).filter(Boolean) ?? []);

const Query = z.object({
  q: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
  claims: csv,
  labels: csv,
  excludeAllergens: csv,
  /** Optional: ties the search to a mandate in the audit trail. */
  mandateId: z.string().optional(),
});

/**
 * GET /api/products/search?q=lactose-free milk&claims=FREE_FROM_LACTOSE&excludeAllergens=AN,AP&limit=10
 * Static catalog data only. Ask POST /api/quotes for price and availability of the products you pick.
 */
export async function GET(request: NextRequest) {
  try {
    const { q, limit, mandateId, ...filters } = Query.parse(Object.fromEntries(request.nextUrl.searchParams));
    const products = await searchProducts(q, filters, limit);

    await logAudit({
      actor: 'agent',
      action: 'catalog_searched',
      mandateId: mandateId ?? null,
      quoteId: null,
      orderId: null,
      summary: `Searched the catalog for "${q}" and got ${products.length} product(s).`,
      data: { q, ...filters, productIds: products.map((p) => p.id) },
    });

    return Response.json({ products });
  } catch (err) {
    return errorResponse(err);
  }
}
