import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { exposeOrder } from '@/lib/exposure';
import { errorResponse } from '@/lib/http';
import { listOrders, placeOrder } from '@/lib/purchasing';

const Body = z.object({ quoteId: z.uuid() });
const Status = z.enum(['confirmed', 'pending_approval', 'rejected']).optional();

/**
 * POST /api/orders  { quoteId }
 * Commits to a quote. The order comes back `confirmed`, `pending_approval` or `rejected`,
 * with `policyReasons` explaining anything other than an automatic confirmation.
 */
export async function POST(request: Request) {
  try {
    const { quoteId } = Body.parse(await request.json());
    return Response.json({ order: exposeOrder(await placeOrder(quoteId)) }, { status: 201 });
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
