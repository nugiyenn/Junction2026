import 'server-only';
import { createHash } from 'node:crypto';
import Valkey from 'iovalkey';

/**
 * Aiven for Valkey is the gateway's protective layer: a short cache in front of Valio's rate-limited
 * API, per-agent rate limits and idempotent orders. It is strictly optional. Without `AIVEN_VALKEY_URL`,
 * or when Valkey errors, those protections are off and requests go straight through (see `/api/health`).
 */

/** The few Valkey commands the gateway needs, so tests can inject an in-memory fake. */
export interface KV {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  /** Sets only if the key does not exist. Returns whether it was set. */
  setNx(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  del(key: string): Promise<void>;
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number): Promise<void>;
  ping(): Promise<void>;
}

declare global {
  var valkeyClient: Valkey | undefined;
}

let override: KV | null | undefined;
let downUntil = 0;
/** After an error, skip Valkey for this long so an outage costs one timeout, not one per request. */
const BACKOFF_MS = 10_000;

/** Tests only: inject a fake (or `null` for "not configured"); `undefined` restores the real client. */
export function setKVForTests(kv: KV | null | undefined) {
  override = kv;
  downUntil = 0;
}

export function valkeyConfigured(): boolean {
  return override !== undefined ? override !== null : Boolean(process.env.AIVEN_VALKEY_URL);
}

function createClient(url: string): Valkey {
  const client = new Valkey(url, {
    // Same trade-off as db.ts: Aiven signs with its own CA, so keep the connection encrypted without verifying the chain.
    tls: url.startsWith('rediss://') ? { rejectUnauthorized: false } : undefined,
    // Valkey must never slow a request down much: short timeouts, one retry.
    connectTimeout: 2000,
    commandTimeout: 1000,
    maxRetriesPerRequest: 1,
  });
  // Errors surface through each command; this only keeps a dropped socket from crashing the process.
  client.on('error', () => {});
  return client;
}

/** Creates the client on first use; throws `Missing AIVEN_VALKEY_URL` when it is not configured. */
export function getKV(): KV {
  if (override) return override;
  const url = process.env.AIVEN_VALKEY_URL;
  if (override === null || !url) throw new Error('Missing AIVEN_VALKEY_URL: cannot connect to valkey');

  // Cached on `global` so dev hot reloads reuse one connection.
  const client = (global.valkeyClient ??= createClient(url));
  return {
    get: (key) => client.get(key),
    set: async (key, value, ttl) => void (await client.set(key, value, 'EX', ttl)),
    setNx: async (key, value, ttl) => (await client.set(key, value, 'EX', ttl, 'NX')) === 'OK',
    del: async (key) => void (await client.del(key)),
    incr: (key) => client.incr(key),
    pexpire: async (key, ms) => void (await client.pexpire(key, ms)),
    ping: async () => void (await client.ping()),
  };
}

/**
 * Runs a Valkey operation and never throws: unconfigured, backing off, or failing all return `fallback`.
 * Errors are logged and start a short back-off.
 */
export async function withKV<T>(op: (kv: KV) => Promise<T>, fallback: T): Promise<T> {
  if (!valkeyConfigured() || Date.now() < downUntil) return fallback;
  try {
    return await op(getKV());
  } catch (err) {
    downUntil = Date.now() + BACKOFF_MS;
    console.error('Valkey error, caching, rate limiting and idempotency are off for 10 s:', err instanceof Error ? err.message : err);
    return fallback;
  }
}

const HITS = 'stats:valio:hits';
const MISSES = 'stats:valio:misses';

/** Valio API calls saved (`hits`) and made (`misses`) through the cache. */
export async function readCacheStats(kv: KV): Promise<{ hits: number; misses: number }> {
  const [hits, misses] = await Promise.all([kv.get(HITS), kv.get(MISSES)]);
  return { hits: Number(hits ?? 0), misses: Number(misses ?? 0) };
}

/** Same customer, date and set of products gives the same key, whatever the order. */
export function valioKey(kind: 'price' | 'availability', customer: string, date: string, productIds: string[]): string {
  const ids = [...new Set(productIds)].sort().join(',');
  return `valio:${kind}:${customer}:${date}:${createHash('sha256').update(ids).digest('hex').slice(0, 32)}`;
}

/**
 * Returns the cached JSON for `key`, or runs `load` and caches its result for `ttlSeconds`.
 * Counts hits and misses. A failed `load` is never cached. Valkey trouble just means `load` runs.
 */
export async function cached<T>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
  const raw = await withKV((kv) => kv.get(key), null);
  if (raw !== null) {
    try {
      const value = JSON.parse(raw) as T;
      await withKV((kv) => kv.incr(HITS), 0);
      return value;
    } catch {
      // unreadable entry: treat as a miss and overwrite it
    }
  }
  await withKV((kv) => kv.incr(MISSES), 0);
  const value = await load();
  await withKV((kv) => kv.set(key, JSON.stringify(value), ttlSeconds), undefined);
  return value;
}
