import { z } from 'zod';
import { requireApprover } from '@/lib/auth';
import { errorResponse } from '@/lib/http';
import { getMandate, updateMandate } from '@/lib/purchasing';

const Body = z.object({
  changedBy: z.string().min(1),
  autoApproveLimitEur: z.number().min(0).optional(),
  maxOrderEur: z.number().min(0).optional(),
  blockedAllergens: z.array(z.string().regex(/^[A-Z0-9]{2,3}$/)).max(20).optional(),
  minDeliveryReliability: z.number().min(0).max(1).nullable().optional(),
  requireConfirmedStock: z.boolean().optional(),
  maxCo2PerKg: z.number().min(0).nullable().optional(),
  preferredOffer: z.enum(['cheapest', 'most_reliable', 'lowest_co2']).optional(),
});

export async function GET(_request: Request, ctx: RouteContext<'/api/mandates/[id]'>) {
  try {
    return Response.json({ mandate: await getMandate((await ctx.params).id) });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * PATCH /api/mandates/:id  { changedBy, autoApproveLimitEur?, maxOrderEur?, blockedAllergens?,
 *                            minDeliveryReliability? (0-1 or null), requireConfirmedStock?,
 *                            maxCo2PerKg? (kg CO2-eq per kg, or null), preferredOffer? }
 * The buyer edits what the agent may do. Every change is written to the audit trail. Needs the approver key when APPROVER_KEY is set.
 */
export async function PATCH(request: Request, ctx: RouteContext<'/api/mandates/[id]'>) {
  try {
    requireApprover(request);
    const { changedBy, ...changes } = Body.parse(await request.json());
    return Response.json({ mandate: await updateMandate((await ctx.params).id, changes, changedBy) });
  } catch (err) {
    return errorResponse(err);
  }
}
