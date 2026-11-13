import { errorResponse } from '@/lib/http';
import { listMandates } from '@/lib/purchasing';

/** GET /api/mandates  — the buyers' mandates: what each agent may decide alone. */
export async function GET() {
  try {
    return Response.json({ mandates: await listMandates() });
  } catch (err) {
    return errorResponse(err);
  }
}
