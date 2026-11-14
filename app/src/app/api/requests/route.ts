import { z } from 'zod';
import { withTimeout } from '@/lib/deadline';
import { errorResponse, HttpError } from '@/lib/http';
import { enforceRateLimit } from '@/lib/ratelimit';
import { MAX_REQUEST_CHARS } from '@/lib/interpret';
import { planRequest } from '@/lib/request';

/** Model calls and live web reads take up to a couple of minutes: ask the host for the longest limit it allows. */
export const maxDuration = 300;

const Body = z.object({
  mandateId: z.string().min(1),
  text: z.string().min(3).max(MAX_REQUEST_CHARS),
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
    // The route may run for 300 s on the host; answer with a clear error a little before that instead of a platform timeout page.
    const result = await withTimeout(
      planRequest(mandateId, text),
      270_000,
      () => new HttpError(504, 'This request took too long. Nothing was ordered. Try again.')
    );
    return Response.json(result, { status: 201, headers });
  } catch (err) {
    return errorResponse(err);
  }
}
