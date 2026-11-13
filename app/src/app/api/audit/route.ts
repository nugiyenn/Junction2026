import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { listAudit } from '@/lib/audit';
import { errorResponse } from '@/lib/http';

const Query = z.object({ orderId: z.uuid().optional(), mandateId: z.string().optional() });

/** GET /api/audit?orderId=...&mandateId=...  — newest first, one plain-language `summary` per event. */
export async function GET(request: NextRequest) {
  try {
    const filter = Query.parse(Object.fromEntries(request.nextUrl.searchParams));
    return Response.json({ events: await listAudit(filter) });
  } catch (err) {
    return errorResponse(err);
  }
}
