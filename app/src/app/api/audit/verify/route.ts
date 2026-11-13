import { verifyAuditChain } from '@/lib/audit';
import { errorResponse } from '@/lib/http';

/**
 * GET /api/audit/verify
 * Re-computes the whole audit trail's hash chain. `valid: false` names the first event that was changed,
 * removed or reordered. `head` is the newest hash: record it elsewhere to also expose cut-off events.
 */
export async function GET() {
  try {
    return Response.json(await verifyAuditChain());
  } catch (err) {
    return errorResponse(err);
  }
}
