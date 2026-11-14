import type { NextRequest } from 'next/server';
import { errorResponse } from '@/lib/http';
import { enforceRateLimit } from '@/lib/ratelimit';
import { getVerifications, verifyProduct } from '@/lib/verify';

/** Model calls and live web reads take up to a couple of minutes: ask the host for the longest limit it allows. */
export const maxDuration = 300;

/** GET /api/products/:id/verify  — the stored check, if there is one. No live call. */
export async function GET(_request: NextRequest, ctx: RouteContext<'/api/products/[id]/verify'>) {
  try {
    const { id } = await ctx.params;
    return Response.json({ verification: (await getVerifications([id])).get(id) ?? null });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * POST /api/products/:id/verify[?force=true]
 * Checks the product's allergen and label claims against the live web (Oxylabs search and scrape). Every
 * statement carries a quote from the page and its source URL. A check younger than 24 hours is reused.
 */
export async function POST(request: NextRequest, ctx: RouteContext<'/api/products/[id]/verify'>) {
  try {
    const { id } = await ctx.params;
    await enforceRateLimit('verify', 'all');
    const force = request.nextUrl.searchParams.get('force') === 'true';
    return Response.json({ verification: await verifyProduct(id, { force }) });
  } catch (err) {
    return errorResponse(err);
  }
}
