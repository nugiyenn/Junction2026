import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { exposeOrder } from '@/lib/exposure';
import { errorResponse } from '@/lib/http';
import { idempotent, readIdempotencyKey } from '@/lib/idempotency';
import { getQuote, listOrders, placeOrder } from '@/lib/purchasing';
import { enforceRateLimit } from '@/lib/ratelimit';

const Body = z.object({ quoteId: z.uuid() });
const Status = z.enum(['confirmed', 'pending_approval', 'rejected']).optional();

/**
 * POST /api/orders  { quoteId }
 * Commits to a quote. The order comes back `confirmed`, `pending_approval` or `rejected`,
 * with `policyReasons` explaining anything other than an automatic confirmation.
 * Rate limited per mandate. With an `Idempotency-Key` header, a retry gets the first order back
 * (header `Idempotent-Replayed: true`) instead of a 409 for an already ordered quote.
 */
export async function POST(request: Request) {
  try {
    const { quoteId } = Body.parse(await request.json());
    const key = readIdempotencyKey(request);
    const { mandateId } = await getQuote(quoteId);
    const rateHeaders = await enforceRateLimit('orders', mandateId);
    const { body, replayed } = await idempotent(`orders:${mandateId}`, key, quoteId, async () => ({
      order: exposeOrder(await placeOrder(quoteId)),
    }));
    return Response.json(body, { status: 201, headers: { ...rateHeaders, ...(replayed ? { 'Idempotent-Replayed': 'true' } : {}) } });
  } catch (err) {
    return errorResponse(err);
  }
}

/** GET /api/orders?status=pending_approval */
export async function GET(request: NextRequest) {
  try {
    const status = Status.parse(request.nextUrl.searchParams.get('status') ?? undefined);
    return Response.json({ orders: (await listOrders(status)).map(exposeOrder) });
  } catch (err) {
    return errorResponse(err);
  }
}
