import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { errorResponse } from '@/lib/http';
import { getMandate } from '@/lib/purchasing';
import { getBuyerStats } from '@/lib/stats';

const Query = z.object({ mandateId: z.string().min(1), source: z.enum(['postgres']).optional() });

/**
 * GET /api/stats?mandateId=...
 * How one buyer's orders behave over time. Answered from ClickHouse when it is configured and reachable, otherwise
 * from Postgres; `source` says which, and `infra` shows Kafka and ClickHouse as they really are.
 */
export async function GET(request: NextRequest) {
  try {
    const q = Query.parse(Object.fromEntries(request.nextUrl.searchParams));
    const mandate = await getMandate(q.mandateId); // 404 for an unknown buyer
    return Response.json(await getBuyerStats(mandate.id, mandate.buyerName, { forcePostgres: q.source === 'postgres' }));
  } catch (err) {
    return errorResponse(err);
  }
}
