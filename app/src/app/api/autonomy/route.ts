import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { requireApprover } from '@/lib/auth';
import { AcceptBody } from '@/lib/autonomy-accept';
import { acceptSuggestion, getAutonomy } from '@/lib/autonomy';
import { errorResponse } from '@/lib/http';

const Query = z.object({ mandateId: z.string().min(1) });

/**
 * GET /api/autonomy?mandateId=...
 * Proposals to loosen or tighten the auto-approve limit, computed from the buyer's record of human decisions.
 * Real orders and labelled synthetic demo history; `note` says how much is synthetic.
 */
export async function GET(request: NextRequest) {
  try {
    const q = Query.parse(Object.fromEntries(request.nextUrl.searchParams));
    return Response.json(await getAutonomy(q.mandateId));
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * POST /api/autonomy  { mandateId, suggestionId, decidedBy }
 * A person accepts a suggestion. It is recomputed first (409 when the id is no longer current), then applied through the
 * mandate update, which writes the decision record. Needs the approver key when APPROVER_KEY is set.
 */
export async function POST(request: Request) {
  try {
    requireApprover(request);
    const b = AcceptBody.parse(await request.json());
    return Response.json(await acceptSuggestion(b.mandateId, b.suggestionId, b.decidedBy));
  } catch (err) {
    return errorResponse(err);
  }
}
