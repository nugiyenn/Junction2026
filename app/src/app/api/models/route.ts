import results from '../../../../eval/results.json';
import type { EvalResults } from '@/types';

/** GET /api/models  — the last model evaluation (eval/results.json), as written by scripts/eval-models.mts. */
export async function GET() {
  return Response.json(results as unknown as EvalResults);
}
