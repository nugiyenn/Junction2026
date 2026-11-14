import { z } from 'zod';
import { HttpError } from './http.ts';
import type { AutonomySuggestion } from '../types/index.ts';

/** POST /api/autonomy body. */
export const AcceptBody = z.object({
  mandateId: z.string().min(1),
  suggestionId: z.string().min(1),
  decidedBy: z.string().trim().min(1),
});

/** The recomputed suggestion with this id, or a 409: the history or the limit moved since the person looked. */
export function pickSuggestion(current: AutonomySuggestion[], id: string): AutonomySuggestion {
  const found = current.find((s) => s.id === id);
  if (!found) throw new HttpError(409, 'This suggestion is no longer current: the history or the limit has changed. Reload and look again.');
  return found;
}
