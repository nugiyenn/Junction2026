import { getPool } from '@/lib/db';
import { assertDemoAllowed } from '@/lib/demo';
import { requireApprover } from '@/lib/auth';
import { errorResponse, HttpError } from '@/lib/http';

/**
 * POST /api/demo/tamper
 * Demo only: rewrites the text of one earlier audit event directly in the database, as an attacker or a careless
 * admin might, so the hash chain's detection can be shown. Reset the demo data to start a clean chain again.
 */
export async function POST(request: Request) {
  try {
    requireApprover(request);
    assertDemoAllowed();
    const { rows } = await getPool().query<{ id: string }>(
      `UPDATE audit_events SET summary = summary || ' [edited after the fact]'
       WHERE id = (SELECT id FROM audit_events ORDER BY id OFFSET (SELECT count(*) / 2 FROM audit_events) LIMIT 1)
       RETURNING id::text`
    );
    if (rows.length === 0) throw new HttpError(409, 'There are no audit events to tamper with yet.');
    return Response.json({ tamperedEventId: rows[0].id });
  } catch (err) {
    return errorResponse(err);
  }
}
