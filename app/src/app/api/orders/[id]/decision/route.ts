import { z } from 'zod';
import { exposeOrder } from '@/lib/exposure';
import { requireApprover } from '@/lib/auth';
import { errorResponse, HttpError } from '@/lib/http';
import { decideOrder } from '@/lib/purchasing';
import { verifyApproverSignature } from '@/lib/receipt-verify';

const Body = z.object({
  decision: z.enum(['approve', 'decline']),
  decidedBy: z.string().min(1),
  note: z.string().optional(),
  /** Approve only: also count this flagged order as the buyer's new normal in future unusual-order checks. */
  acceptAsNormal: z.boolean().optional(),
  /** The decision signed by the approver's device key. Optional: older clients and scripts do not send it. */
  signature: z
    .object({
      payload: z.object({
        orderId: z.string(),
        decision: z.enum(['approve', 'decline']),
        decidedBy: z.string(),
        note: z.string().nullable(),
        signedAt: z.string(),
      }),
      value: z.string().min(1),
      publicKey: z.object({ kty: z.literal('EC'), crv: z.literal('P-256'), x: z.string(), y: z.string() }),
    })
    .optional(),
});

/**
 * POST /api/orders/:id/decision  { decision: "approve" | "decline", decidedBy, note?, acceptAsNormal?, signature? }
 * The human sign-off for an order in `pending_approval`. Needs the approver key when APPROVER_KEY is set.
 * `acceptAsNormal: true` (approve only, for an order flagged as unusual) records that the order is the buyer's new normal.
 * A signature must be the device's ES256 signature over exactly this decision, or the request is refused.
 */
export async function POST(request: Request, ctx: RouteContext<'/api/orders/[id]/decision'>) {
  try {
    requireApprover(request);
    const id = z.uuid().parse((await ctx.params).id);
    const { decision, decidedBy, note, signature, acceptAsNormal } = Body.parse(await request.json());
    const approval = signature && { alg: 'ES256' as const, ...signature };
    if (approval) {
      const p = approval.payload;
      if (p.orderId !== id || p.decision !== decision || p.decidedBy !== decidedBy || p.note !== (note ?? null)) {
        throw new HttpError(400, 'The signed decision does not match the decision sent.');
      }
      if (!(await verifyApproverSignature(approval))) throw new HttpError(400, 'The decision signature does not verify.');
    }
    return Response.json({ order: exposeOrder(await decideOrder(id, decision, decidedBy, note, approval, acceptAsNormal)) });
  } catch (err) {
    return errorResponse(err);
  }
}
