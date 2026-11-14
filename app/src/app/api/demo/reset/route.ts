import { getPool } from '@/lib/db';
import { assertDemoAllowed } from '@/lib/demo';
import { requireApprover } from '@/lib/auth';
import { errorResponse } from '@/lib/http';

/**
 * POST /api/demo/reset
 * Clears quotes, orders and the audit trail (which starts a new hash chain) so a demo starts clean.
 * Mandates, the catalog and stored web checks are kept.
 */
export async function POST(request: Request) {
  try {
    requireApprover(request);
    assertDemoAllowed();
    await getPool().query('TRUNCATE audit_events, orders, quotes RESTART IDENTITY');
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
