import { assertDemoAllowed } from '@/lib/demo';
import { exposeQuote } from '@/lib/exposure';
import { errorResponse } from '@/lib/http';
import { getQuote } from '@/lib/purchasing';
import { verifyQuoteSignature } from '@/lib/signing';

/**
 * GET /api/quotes/:id/views  (or /latest/views)
 * Demo only: the same quote as Valio holds it and as an agent receives it, side by side, to show what the
 * exposure policy withholds. Refused in production, because the internal side is Valio's confidential data.
 */
export async function GET(_request: Request, ctx: RouteContext<'/api/quotes/[id]/views'>) {
  try {
    assertDemoAllowed();
    const quote = await getQuote((await ctx.params).id);
    return Response.json({ internal: quote, agent: exposeQuote(quote), signatureValid: await verifyQuoteSignature(quote) });
  } catch (err) {
    return errorResponse(err);
  }
}
