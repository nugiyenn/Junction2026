import { z } from 'zod';
import { errorResponse } from '@/lib/http';
import { enforceRateLimit } from '@/lib/ratelimit';
import { planRequest } from '@/lib/request';

/** Model calls and live web reads take up to a couple of minutes: ask the host for the longest limit it allows. */
export const maxDuration = 300;

const Body = z.object({
  mandateId: z.string().min(1),
  text: z.string().min(3).max(500),
});

/**
 * POST /api/requests  { mandateId, text: "I need 1,000 litres of lactose-free milk by Monday" }
 * Returns the interpreted need, ranked candidates with reasons, and a held quote for the best one.
 * Rate limited per mandate: this is the call that spends model and web quota.
 */
export async function POST(request: Request) {
  try {
    const { mandateId, text } = Body.parse(await request.json());
    const headers = await enforceRateLimit('requests', mandateId);
    return Response.json(await planRequest(mandateId, text), { status: 201, headers });
  } catch (err) {
    return errorResponse(err);
  }
}
