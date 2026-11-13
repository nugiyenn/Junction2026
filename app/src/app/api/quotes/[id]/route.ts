import { exposeQuote } from '@/lib/exposure';
import { errorResponse } from '@/lib/http';
import { getQuote } from '@/lib/purchasing';

/** GET /api/quotes/:id  — a quote as an agent sees it, with Valio's signature over its terms. */
export async function GET(_request: Request, ctx: RouteContext<'/api/quotes/[id]'>) {
  try {
    return Response.json({ quote: exposeQuote(await getQuote((await ctx.params).id)) });
  } catch (err) {
    return errorResponse(err);
  }
}
