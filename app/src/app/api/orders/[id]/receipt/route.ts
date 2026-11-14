import { z } from 'zod';
import { errorResponse } from '@/lib/http';
import { getReceipt } from '@/lib/receipt';

/**
 * GET /api/orders/:id/receipt
 * A signed bundle for one order: the order and quote as an agent sees them, the mandate that applied, the policy
 * outcome, the human decision (with the approver's device signature when there is one) and the audit events.
 * It can be checked offline at /verify against Valio's public key.
 */
export async function GET(_request: Request, ctx: RouteContext<'/api/orders/[id]/receipt'>) {
  try {
    const id = z.uuid().parse((await ctx.params).id);
    return new Response(JSON.stringify(await getReceipt(id), null, 2), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
