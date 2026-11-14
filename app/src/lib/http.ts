import { ZodError } from 'zod';
import type { ApiError } from '@/types';

/** Throw from lib code to answer with a specific HTTP status and message (and optional response headers). */
export class HttpError extends Error {
  status: number;
  headers: Record<string, string>;
  constructor(status: number, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

/** Turns anything thrown in a route handler into a JSON `ApiError` response. */
export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) return Response.json({ error: err.message } satisfies ApiError, { status: err.status, headers: err.headers });
  if (err instanceof ZodError) {
    const error = err.issues.map((i) => `${i.path.join('.') || 'request'}: ${i.message}`).join('; ');
    return Response.json({ error } satisfies ApiError, { status: 400 });
  }
  if (err instanceof SyntaxError) return Response.json({ error: 'The request body is not valid JSON.' } satisfies ApiError, { status: 400 });
  console.error(err);
  const error = err instanceof Error ? err.message : 'Unknown error';
  return Response.json({ error } satisfies ApiError, { status: 500 });
}
