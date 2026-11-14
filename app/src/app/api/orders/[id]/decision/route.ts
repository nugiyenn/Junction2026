import { z } from 'zod';
import { exposeOrder } from '@/lib/exposure';
import { requireApprover } from '@/lib/auth';
import { errorResponse } from '@/lib/http';
import { decideOrder } from '@/lib/purchasing';

const Body = z.object({
  decision: z.enum(['approve', 'decline']),
  decidedBy: z.string().min(1),
  note: z.string().optional(),
});

/**
 * POST /api/orders/:id/decision  { decision: "approve" | "decline", decidedBy, note? }
 * The human sign-off for an order in `pending_approval`. Needs the approver key when APPROVER_KEY is set.
 */
export async function POST(request: Request, ctx: RouteContext<'/api/orders/[id]/decision'>) {
  try {
    requireApprover(request);
    const id = z.uuid().parse((await ctx.params).id);
    const { decision, decidedBy, note } = Body.parse(await request.json());
    return Response.json({ order: exposeOrder(await decideOrder(id, decision, decidedBy, note)) });
  } catch (err) {
    return errorResponse(err);
  }
}
