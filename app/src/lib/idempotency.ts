import 'server-only';
import { createHash } from 'node:crypto';
import { withKV } from './cache.ts';
import { HttpError } from './http.ts';

const KEEP_SECONDS = 24 * 60 * 60;
/** A claimed key whose request never finished (crash, timeout) frees itself after this long. */
const IN_FLIGHT_SECONDS = 60;

type Stored = { state: 'in_flight' } | { state: 'done'; fingerprint: string; body: unknown };

export function readIdempotencyKey(request: Request): string | null {
  const key = request.headers.get('Idempotency-Key');
  if (key === null) return null;
  if (key.length < 1 || key.length > 255) throw new HttpError(400, 'Idempotency-Key must be 1 to 255 characters.');
  return key;
}

/**
 * Runs `run` once per (scope, key): the first success is kept for 24 h and replayed to every retry.
 * `fingerprint` identifies the request body: the same key with a different body is a 422, not a replay.
 * Failed runs are not kept, so a retry can try again. Without a key, or without Valkey, it just runs.
 */
export async function idempotent<T>(
  scope: string,
  key: string | null,
  fingerprint: string,
  run: () => Promise<T>
): Promise<{ body: T; replayed: boolean }> {
  if (key === null) return { body: await run(), replayed: false };
  const redisKey = `idem:${scope}:${createHash('sha256').update(key).digest('hex')}`;

  const raw = await withKV((kv) => kv.get(redisKey), null);
  if (raw !== null) {
    const stored = JSON.parse(raw) as Stored;
    if (stored.state === 'in_flight') throw new HttpError(409, 'A request with this Idempotency-Key is still being processed. Retry shortly.');
    if (stored.fingerprint !== fingerprint) throw new HttpError(422, 'This Idempotency-Key was already used with a different request.');
    return { body: stored.body as T, replayed: true };
  }

  // Claim the key so two simultaneous retries cannot both run. If Valkey is down this is treated as claimed.
  const claimed = await withKV((kv) => kv.setNx(redisKey, JSON.stringify({ state: 'in_flight' } satisfies Stored), IN_FLIGHT_SECONDS), true);
  if (!claimed) throw new HttpError(409, 'A request with this Idempotency-Key is still being processed. Retry shortly.');

  let body: T;
  try {
    body = await run();
  } catch (err) {
    await withKV((kv) => kv.del(redisKey), undefined);
    throw err;
  }
  await withKV((kv) => kv.set(redisKey, JSON.stringify({ state: 'done', fingerprint, body } satisfies Stored), KEEP_SECONDS), undefined);
  return { body, replayed: false };
}
