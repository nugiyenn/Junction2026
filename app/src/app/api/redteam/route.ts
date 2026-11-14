import { z } from 'zod';
import { errorResponse } from '@/lib/http';
import { enforceRateLimit } from '@/lib/ratelimit';
import { attackText, runScenarios, SCENARIOS } from '@/lib/redteam';
import type { RedTeamScenarioInfo } from '@/types';

/** The harness reads a request with two models and calls Valio for some scenarios: allow the longest run the host permits. */
export const maxDuration = 300;

const Body = z.union([z.object({ id: z.string() }), z.object({ all: z.literal(true) }), z.object({ text: z.string().min(3).max(500) })]);

/** GET /api/redteam: the attack scenarios, without running anything. */
export async function GET() {
  return Response.json({ scenarios: SCENARIOS.map(({ id, title, attempt, mechanism }): RedTeamScenarioInfo => ({ id, title, attempt, mechanism })) });
}

/**
 * POST /api/redteam  { id } | { all: true } | { text }
 * Runs the attacks for real against the gateway's functions on the dedicated `demo-redteam` mandate and reports for each
 * whether it was blocked, allowed, not protected (the protection is not configured) or skipped. `{ text }` instead reads
 * one request text with the real reader and shows the policy outcome. Rate limited.
 */
export async function POST(request: Request) {
  try {
    const body = Body.parse(await request.json());
    const headers = await enforceRateLimit('redteam', 'all');
    if ('text' in body) return Response.json(await attackText(body.text), { headers });
    const ids = 'all' in body ? SCENARIOS.map((s) => s.id) : [body.id];
    return Response.json({ results: await runScenarios(ids) }, { headers });
  } catch (err) {
    return errorResponse(err);
  }
}
