import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { cached, readCacheStats, setKVForTests, valioKey, type KV } from '../src/lib/cache.ts';
import { HttpError } from '../src/lib/http.ts';
import { idempotent } from '../src/lib/idempotency.ts';
import { checkRateLimit, enforceRateLimit, LIMITS } from '../src/lib/ratelimit.ts';
import { getAvailability, getPrices } from '../src/lib/valio.ts';

/** In-memory Valkey with a clock the tests move by hand. */
class FakeKV implements KV {
  now = 1_000_000;
  fail = false;
  store = new Map<string, { value: string; expiresAt: number }>();
  private live(key: string) {
    this.guard();
    const e = this.store.get(key);
    if (e && e.expiresAt <= this.now) this.store.delete(key);
    return this.store.get(key);
  }
  private guard() {
    if (this.fail) throw new Error('connection refused');
  }
  advance(seconds: number) {
    this.now += seconds * 1000;
  }
  async get(key: string) {
    return this.live(key)?.value ?? null;
  }
  async set(key: string, value: string, ttl: number) {
    this.guard();
    this.store.set(key, { value, expiresAt: this.now + ttl * 1000 });
  }
  async setNx(key: string, value: string, ttl: number) {
    if (this.live(key)) return false;
    await this.set(key, value, ttl);
    return true;
  }
  async del(key: string) {
    this.guard();
    this.store.delete(key);
  }
  async incr(key: string) {
    const e = this.live(key);
    const n = Number(e?.value ?? 0) + 1;
    this.store.set(key, { value: String(n), expiresAt: e?.expiresAt ?? Infinity });
    return n;
  }
  async pexpire(key: string, ms: number) {
    const e = this.live(key);
    if (e) e.expiresAt = this.now + ms;
  }
  async ping() {
    this.guard();
  }
}

let kv: FakeKV;
beforeEach(() => {
  kv = new FakeKV();
  setKVForTests(kv);
});
afterEach(() => setKVForTests(undefined));

describe('valioKey', () => {
  it('ignores product order and duplicates, but not customer, date or kind', () => {
    assert.equal(valioKey('price', '1', '2026-11-20', ['b', 'a']), valioKey('price', '1', '2026-11-20', ['a', 'b', 'a']));
    assert.notEqual(valioKey('price', '1', '2026-11-20', ['a']), valioKey('price', '2', '2026-11-20', ['a']));
    assert.notEqual(valioKey('price', '1', '2026-11-20', ['a']), valioKey('price', '1', '2026-11-21', ['a']));
    assert.notEqual(valioKey('price', '1', '2026-11-20', ['a']), valioKey('availability', '1', '2026-11-20', ['a']));
  });
});

describe('cached', () => {
  it('loads once, then serves hits until the TTL ends, and counts both', async () => {
    let calls = 0;
    const load = async () => ({ n: ++calls });
    assert.deepEqual(await cached('k', 30, load), { n: 1 });
    assert.deepEqual(await cached('k', 30, load), { n: 1 });
    kv.advance(29);
    assert.deepEqual(await cached('k', 30, load), { n: 1 });
    kv.advance(2);
    assert.deepEqual(await cached('k', 30, load), { n: 2 });
    assert.deepEqual(await readCacheStats(kv), { hits: 2, misses: 2 });
  });

  it('does not cache a failed load', async () => {
    await assert.rejects(cached('k', 30, async () => Promise.reject(new Error('Valio error (429)'))), /429/);
    assert.deepEqual(await cached('k', 30, async () => 'ok'), 'ok');
  });

  it('just loads when Valkey is not configured', async () => {
    setKVForTests(null);
    let calls = 0;
    await cached('k', 30, async () => ++calls);
    await cached('k', 30, async () => ++calls);
    assert.equal(calls, 2);
  });

  it('just loads when Valkey errors, and stays out of the way afterwards', async () => {
    kv.fail = true;
    const errors = console.error;
    console.error = () => {};
    try {
      let calls = 0;
      assert.equal(await cached('k', 30, async () => ++calls), 1);
      assert.equal(await cached('k', 30, async () => ++calls), 2);
    } finally {
      console.error = errors;
    }
  });
});

describe('Valio client cache', () => {
  const realFetch = globalThis.fetch;
  let fetches: string[];
  beforeEach(() => {
    process.env.VALIO_API_KEY = 'test-key';
    fetches = [];
    globalThis.fetch = (async (url: string) => {
      fetches.push(String(url));
      return Response.json({ products: [] });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('answers the same prices lookup from cache, in any product order', async () => {
    await getPrices(['b', 'a'], '2026-11-20');
    await getPrices(['a', 'b'], '2026-11-20');
    await getPrices(['a', 'b'], '2026-11-21');
    assert.equal(fetches.length, 2);
    assert.deepEqual(await readCacheStats(kv), { hits: 1, misses: 2 });
  });

  it('keeps prices 30 s and availability 15 s', async () => {
    await getPrices(['a'], '2026-11-20');
    await getAvailability(['a'], '2026-11-20');
    kv.advance(20);
    await getPrices(['a'], '2026-11-20');
    await getAvailability(['a'], '2026-11-20');
    assert.deepEqual(fetches.map((u) => u.split('/').pop()), ['price', 'availability', 'availability']);
  });

  it('calls Valio every time without Valkey', async () => {
    setKVForTests(null);
    await getPrices(['a'], '2026-11-20');
    await getPrices(['a'], '2026-11-20');
    assert.equal(fetches.length, 2);
  });
});

describe('rate limit', () => {
  it('allows the limit, then says no, with the window reset', async () => {
    const at = kv.now;
    const { limit } = LIMITS.requests;
    for (let i = 1; i <= limit; i++) {
      const r = await checkRateLimit('requests', 'demo-hotel', at);
      assert.equal(r?.allowed, true);
      assert.equal(r?.remaining, limit - i);
    }
    const over = await checkRateLimit('requests', 'demo-hotel', at);
    assert.equal(over?.allowed, false);
    assert.equal(over?.remaining, 0);
    assert.equal(over?.limit, limit);
    assert.ok(over && over.resetSeconds >= 1 && over.resetSeconds <= 60);
  });

  it('counts each mandate and each scope separately', async () => {
    for (let i = 0; i < LIMITS.requests.limit; i++) await checkRateLimit('requests', 'a', kv.now);
    assert.equal((await checkRateLimit('requests', 'b', kv.now))?.allowed, true);
    assert.equal((await checkRateLimit('quotes', 'a', kv.now))?.allowed, true);
  });

  it('starts over in the next window', async () => {
    const at = kv.now;
    for (let i = 0; i <= LIMITS.requests.limit; i++) await checkRateLimit('requests', 'a', at);
    assert.equal((await checkRateLimit('requests', 'a', at + 61_000))?.allowed, true);
  });

  it('throws a 429 with Retry-After and X-RateLimit headers when over', async () => {
    for (let i = 0; i < LIMITS.orders.limit; i++) await enforceRateLimit('orders', 'a');
    await assert.rejects(enforceRateLimit('orders', 'a'), (err: unknown) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.status, 429);
      assert.ok(Number(err.headers['Retry-After']) >= 1);
      assert.equal(err.headers['X-RateLimit-Limit'], String(LIMITS.orders.limit));
      assert.equal(err.headers['X-RateLimit-Remaining'], '0');
      assert.ok('X-RateLimit-Reset' in err.headers);
      return true;
    });
  });

  it('does not limit when Valkey is off or failing', async () => {
    setKVForTests(null);
    assert.equal(await checkRateLimit('requests', 'a'), null);
    assert.deepEqual(await enforceRateLimit('requests', 'a'), {});
  });
});

describe('idempotency', () => {
  it('runs once and replays the stored body to retries', async () => {
    let runs = 0;
    const run = async () => ({ order: { id: `order-${++runs}` } });
    const first = await idempotent('orders:m', 'key-1', 'quote-1', run);
    const retry = await idempotent('orders:m', 'key-1', 'quote-1', run);
    assert.deepEqual(first, { body: { order: { id: 'order-1' } }, replayed: false });
    assert.deepEqual(retry, { body: { order: { id: 'order-1' } }, replayed: true });
    assert.equal(runs, 1);
  });

  it('keeps the response for 24 hours', async () => {
    let runs = 0;
    const run = async () => ++runs;
    await idempotent('s', 'k', 'f', run);
    kv.advance(23 * 3600);
    assert.equal((await idempotent('s', 'k', 'f', run)).replayed, true);
    kv.advance(2 * 3600);
    assert.equal((await idempotent('s', 'k', 'f', run)).replayed, false);
  });

  it('refuses the same key for a different request with 422', async () => {
    await idempotent('s', 'k', 'quote-1', async () => 1);
    await assert.rejects(idempotent('s', 'k', 'quote-2', async () => 2), (e: unknown) => e instanceof HttpError && e.status === 422);
  });

  it('answers 409 while the first request is still running, and lets a failed one be retried', async () => {
    let release!: () => void;
    const slow = idempotent('s', 'k', 'f', () => new Promise<string>((resolve) => (release = () => resolve('done'))));
    await new Promise((r) => setImmediate(r));
    await assert.rejects(idempotent('s', 'k', 'f', async () => 'x'), (e: unknown) => e instanceof HttpError && e.status === 409);
    release();
    await slow;

    await assert.rejects(idempotent('s', 'k2', 'f', async () => Promise.reject(new Error('quote expired'))), /expired/);
    assert.deepEqual(await idempotent('s', 'k2', 'f', async () => 'second try'), { body: 'second try', replayed: false });
  });

  it('does not store failures', async () => {
    await assert.rejects(idempotent('s', 'k', 'f', async () => Promise.reject(new HttpError(410, 'expired'))));
    assert.equal(kv.store.size, 0);
  });

  it('just runs without a key, without Valkey, or when Valkey errors', async () => {
    let runs = 0;
    const run = async () => ++runs;
    await idempotent('s', null, 'f', run);
    setKVForTests(null);
    await idempotent('s', 'k', 'f', run);
    await idempotent('s', 'k', 'f', run);
    assert.equal(runs, 3);

    setKVForTests(kv);
    kv.fail = true;
    const errors = console.error;
    console.error = () => {};
    try {
      assert.deepEqual(await idempotent('s', 'k', 'f', run), { body: 4, replayed: false });
    } finally {
      console.error = errors;
    }
  });
});
