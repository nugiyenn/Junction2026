import { createHash, timingSafeEqual } from 'node:crypto';
import { HttpError } from './http.ts';

/**
 * Who may approve an order or change a mandate. Those actions are for people, so they need the approver key
 * (`Authorization: Bearer <APPROVER_KEY>`). An agent that only holds the agent API has no way to make them.
 * When APPROVER_KEY is not set the routes stay open, as before, and /api/health says so.
 */
export function approverKeyConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.APPROVER_KEY?.trim());
}

const digest = (value: string) => createHash('sha256').update(value).digest();

/** Throws a 401 with a `WWW-Authenticate` header unless the request carries the approver key (or no key is configured). */
export function requireApprover(request: Request, env: Record<string, string | undefined> = process.env): void {
  const key = env.APPROVER_KEY?.trim();
  if (!key) return;
  const header = request.headers.get('authorization') ?? '';
  const given = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  // Hash both sides so the comparison is constant-time whatever the lengths.
  if (!timingSafeEqual(digest(given), digest(key))) {
    throw new HttpError(401, 'Approver key required.', { 'WWW-Authenticate': 'Bearer realm="approver"' });
  }
}
