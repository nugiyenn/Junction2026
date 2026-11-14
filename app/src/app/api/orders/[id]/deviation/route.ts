import { z } from 'zod';
import { requireApprover } from '@/lib/auth';
import { getDeviationReport } from '@/lib/deviation-history';
import { errorResponse, HttpError } from '@/lib/http';
import { getOrder } from '@/lib/purchasing';

/**
 * GET /api/orders/:id/deviation
 * How the order compared with the buyer's usual orders: what is usual, with the numbers, and what differs.
 * For the approver only (needs the approver key when APPROVER_KEY is set). The agent never gets this: it only sees
 * "Needs approval: differs from this buyer's usual orders."
 */
export async function GET(request: Request, ctx: RouteContext<'/api/orders/[id]/deviation'>) {
  try {
    requireApprover(request);
    const id = z.uuid().parse((await ctx.params).id);
    await getOrder(id); // 404 for an unknown order
    const report = await getDeviationReport(id);
    if (!report) throw new HttpError(404, 'No unusual-order check was recorded for this order.');
    return Response.json({ orderId: id, report }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return errorResponse(err);
  }
}
