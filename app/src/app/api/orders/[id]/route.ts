import { z } from 'zod';
import { exposeOrder } from '@/lib/exposure';
import { errorResponse } from '@/lib/http';
import { getOrder } from '@/lib/purchasing';

/** GET /api/orders/:id  — lets the agent poll an order that is waiting for approval. */
export async function GET(_request: Request, ctx: RouteContext<'/api/orders/[id]'>) {
  try {
    const id = z.uuid().parse((await ctx.params).id);
    return Response.json({ order: exposeOrder(await getOrder(id)) });
  } catch (err) {
    return errorResponse(err);
  }
}
