import 'server-only';
import { withKV } from './cache.ts';
import { HttpError } from './http.ts';

const fromEnv = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

/**
 * Per-agent (per mandate) limits, one fixed window each. Requests are the expensive ones: they call models and the web.
 * The public demo shares one mandate between everyone who opens it, so the defaults leave room for several visitors;
 * set RATE_LIMIT_REQUESTS_PER_MIN, RATE_LIMIT_QUOTES_PER_MIN and RATE_LIMIT_ORDERS_PER_MIN to tighten them.
 */
export const LIMITS = {
  requests: { limit: fromEnv('RATE_LIMIT_REQUESTS_PER_MIN', 20), windowSeconds: 60 },
  quotes: { limit: fromEnv('RATE_LIMIT_QUOTES_PER_MIN', 60), windowSeconds: 60 },
  orders: { limit: fromEnv('RATE_LIMIT_ORDERS_PER_MIN', 30), windowSeconds: 60 },
  // Live web checks spend Oxylabs and model quota and are not tied to a mandate, so one shared counter.
  verify: { limit: fromEnv('RATE_LIMIT_VERIFY_PER_MIN', 12), windowSeconds: 60 },
  // Photo reading spends vision-model quota and is not tied to a mandate: one shared counter.
  intake: { limit: fromEnv('RATE_LIMIT_INTAKE_PER_MIN', 6), windowSeconds: 60 },
  // The red-team harness writes quotes and orders and reads text with models: one shared counter.
  redteam: { limit: fromEnv('RATE_LIMIT_REDTEAM_PER_MIN', 4), windowSeconds: 60 },
} as const;

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the window ends and the count starts again. */
  resetSeconds: number;
}

/**
 * Fixed-window counter in Valkey: INCR a key that names the window, expire it with the window.
 * Returns null when Valkey is off or failing: the request is then not limited.
 */
export async function checkRateLimit(
  scope: keyof typeof LIMITS,
  mandateId: string,
  now = Date.now()
): Promise<RateLimitResult | null> {
  const { limit, windowSeconds } = LIMITS[scope];
  const windowMs = windowSeconds * 1000;
  const window = Math.floor(now / windowMs);
  const count = await withKV(async (kv) => {
    const key = `rl:${scope}:${mandateId}:${window}`;
    const n = await kv.incr(key);
    if (n === 1) await kv.pexpire(key, windowMs);
    return n;
  }, null);
  if (count === null) return null;
  return {
    allowed: count <= limit,
    limit,
    remaining: Math.max(0, limit - count),
    resetSeconds: Math.max(1, Math.ceil(((window + 1) * windowMs - now) / 1000)),
  };
}

/**
 * Counts one call against the mandate's limit. Throws a 429 with `Retry-After` when over it.
 * Returns the `X-RateLimit-*` headers to put on the success response (empty when limiting is off).
 */
export async function enforceRateLimit(scope: keyof typeof LIMITS, mandateId: string): Promise<Record<string, string>> {
  const result = await checkRateLimit(scope, mandateId);
  if (!result) return {};
  const headers = {
    'X-RateLimit-Limit': String(result.limit),
    'X-RateLimit-Remaining': String(result.remaining),
    'X-RateLimit-Reset': String(result.resetSeconds),
  };
  if (!result.allowed) {
    throw new HttpError(
      429,
      `Rate limit reached: ${result.limit} ${scope} per ${LIMITS[scope].windowSeconds} s for this mandate. Retry in ${result.resetSeconds} s.`,
      { ...headers, 'Retry-After': String(result.resetSeconds) }
    );
  }
  return headers;
}
