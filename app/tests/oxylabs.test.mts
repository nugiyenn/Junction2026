import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createOxylabs,
  countryForUrl,
  OxylabsAuthError,
  OxylabsError,
  OxylabsValidationError,
} from '../src/lib/oxylabs.ts';

// Tests use a key of their own, so a failing assertion can only ever print this one.
const DUMMY_KEY = 'test-dummy-key-not-real';
const LONG_PAGE = '# Product\n\n' + 'Real page content. '.repeat(30);

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** A mocked transport that answers from a script and records every request it receives. */
function setup(script: (Response | Error)[]) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  let i = 0;
  const mockFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) });
    const next = script[Math.min(i++, script.length - 1)];
    if (next instanceof Error) throw next;
    return next.clone();
  }) as unknown as typeof fetch;
  const client = createOxylabs({
    fetch: mockFetch,
    sleep: async (ms) => void sleeps.push(ms),
    random: () => 0.5,
    apiKey: () => DUMMY_KEY,
    log: () => {},
  });
  return { client, calls, sleeps };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const searchOk = (requestId = 'req-search') =>
  json(200, {
    state: 'done',
    results: [{ title: 'A page', url: 'https://example.com/a', outline: ['snippet'], metadata: { position: 1 } }],
    metadata: { request_id: requestId },
  });

const scrapeOk = (markdown: string | null, requestId = 'req-scrape', url = 'https://example.com/a') =>
  json(200, { results: markdown === null ? [] : [{ url, markdown }], metadata: { request_id: requestId } });

const problem = (status: number, title: string, extra: object = {}) =>
  json(status, { status, title, detail: 'prose that must not be matched on', metadata: { request_id: `req-${status}` }, ...extra });

const timeout = () => new DOMException('The operation timed out', 'TimeoutError');

describe('search', () => {
  it('sends the bearer key and the documented body, and keeps url and request id', async () => {
    const { client, calls } = setup([searchOk()]);
    const res = await client.search('lactose free milk', { maxResults: 5, location: 'fi' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://webapi.oxylabs.io/v1/search');
    assert.equal(calls[0].headers.Authorization, `Bearer ${DUMMY_KEY}`);
    assert.deepEqual(calls[0].body, { query: 'lactose free milk', max_results: 5, location: 'FI' });
    assert.equal(res.requestId, 'req-search');
    assert.deepEqual(res.results[0], { title: 'A page', url: 'https://example.com/a', outline: ['snippet'], position: 1 });
  });

  it('treats an empty results array on 200 as nothing matched, not an error', async () => {
    const { client } = setup([json(200, { state: 'done', results: [], metadata: { request_id: 'r' } })]);
    assert.deepEqual((await client.search('nothing')).results, []);
  });

  it('accepts any 2xx as success, not only 200', async () => {
    const res = new Response(JSON.stringify({ results: [], metadata: { request_id: 'r202' } }), { status: 202 });
    const { client } = setup([res]);
    assert.equal((await client.search('x')).requestId, 'r202');
  });

  it('refuses invalid input without calling the API', async () => {
    const { client, calls } = setup([searchOk()]);
    await assert.rejects(client.search('x'.repeat(2049)), OxylabsValidationError);
    await assert.rejects(client.search(''), OxylabsValidationError);
    await assert.rejects(client.search('x', { maxResults: 21 }), OxylabsValidationError);
    await assert.rejects(client.search('x', { maxResults: 0 }), OxylabsValidationError);
    await assert.rejects(client.search('x', { location: 'FIN' }), OxylabsValidationError);
    assert.equal(calls.length, 0);
  });
});

describe('retries', () => {
  it('retries 429 with exponential backoff and jitter, then succeeds', async () => {
    const { client, calls, sleeps } = setup([problem(429, 'RATE_LIMITED'), problem(503, 'UNAVAILABLE'), searchOk()]);
    const res = await client.search('x');
    assert.equal(calls.length, 3);
    assert.equal(res.requestId, 'req-search');
    assert.deepEqual(sleeps, [2 * 1000 + 500, 4 * 1000 + 500]); // 2^attempt s + jitter
  });

  it('retries 408 and 5xx, and gives up after 3 attempts with status, code and request id', async () => {
    const { client, calls } = setup([problem(500, 'REQUEST_FAILED_AFTER_MANY_RETRIES')]);
    await assert.rejects(client.search('x'), (err: OxylabsError) => {
      assert.equal(err.status, 500);
      assert.equal(err.title, 'REQUEST_FAILED_AFTER_MANY_RETRIES');
      assert.equal(err.requestId, 'req-500');
      return true;
    });
    assert.equal(calls.length, 3);

    const t = setup([problem(408, 'TIMEOUT'), searchOk()]);
    await t.client.search('x');
    assert.equal(t.calls.length, 2);
  });

  it('retries transport timeouts, and reports a timeout after 3 attempts', async () => {
    const ok = setup([timeout(), searchOk()]);
    await ok.client.search('x');
    assert.equal(ok.calls.length, 2);

    const bad = setup([timeout()]);
    await assert.rejects(bad.client.search('x'), /timed out after 3 attempts/);
    assert.equal(bad.calls.length, 3);
  });

  it('points a persistent 429 at the quota instead of retrying forever', async () => {
    const { client, calls } = setup([problem(429, 'RATE_LIMITED')]);
    await assert.rejects(client.search('x'), /spent quota/);
    assert.equal(calls.length, 3);
  });

  it('does not retry other transport errors', async () => {
    const { client, calls } = setup([new TypeError('fetch failed')]);
    await assert.rejects(client.search('x'), /fetch failed/);
    assert.equal(calls.length, 1);
  });
});

describe('error mapping', () => {
  it('maps 400 to a validation error naming the field, and does not retry', async () => {
    const body = problem(400, 'VALIDATION_ERROR', { errors: [{ pointer: '#/max_results', detail: 'Input should be less than or equal to 20' }] });
    const { client, calls } = setup([body]);
    await assert.rejects(client.search('x'), (err: OxylabsValidationError) => {
      assert.ok(err instanceof OxylabsValidationError);
      assert.equal(err.title, 'VALIDATION_ERROR');
      assert.match(err.message, /#\/max_results/);
      return true;
    });
    assert.equal(calls.length, 1);
  });

  it('maps 401 to an auth error and does not retry', async () => {
    const { client, calls } = setup([problem(401, 'UNAUTHORIZED')]);
    await assert.rejects(client.search('x'), OxylabsAuthError);
    assert.equal(calls.length, 1);
  });

  it('does not retry an unlisted 4xx such as 404', async () => {
    const { client, calls } = setup([problem(404, 'NOT_FOUND')]);
    await assert.rejects(client.search('x'), (err: OxylabsError) => err.status === 404);
    assert.equal(calls.length, 1);
  });

  it('never lets the key into an error message, even if the API echoes it', async () => {
    const echo = problem(400, 'VALIDATION_ERROR', { errors: [{ pointer: '#/query', detail: `bad ${DUMMY_KEY}` }] });
    const { client } = setup([echo]);
    await assert.rejects(client.search('x'), (err: Error) => !err.message.includes(DUMMY_KEY));

    const raw = setup([new Response(`gateway says ${DUMMY_KEY}`, { status: 502 })]);
    await assert.rejects(raw.client.search('x'), (err: Error) => !err.message.includes(DUMMY_KEY));
  });

  it('fails with a clear message when the key is not set', async () => {
    const saved = process.env.OXYLABS_WEB_API_KEY;
    delete process.env.OXYLABS_WEB_API_KEY;
    try {
      const client = createOxylabs({ fetch: (async () => searchOk()) as unknown as typeof fetch });
      await assert.rejects(client.search('x'), /Missing OXYLABS_WEB_API_KEY/);
    } finally {
      if (saved !== undefined) process.env.OXYLABS_WEB_API_KEY = saved;
    }
  });
});

describe('readPage: empty and skeletal pages', () => {
  it('returns a good page on the first plain scrape', async () => {
    const { client, calls } = setup([scrapeOk(LONG_PAGE)]);
    const page = await client.readPage('https://example.com/a');
    assert.ok(page.ok);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body, { url: 'https://example.com/a', output: ['markdown'] });
  });

  it('retries once with run_js when the page is empty', async () => {
    const { client, calls } = setup([scrapeOk(null), scrapeOk(LONG_PAGE)]);
    const page = await client.readPage('https://example.com/a');
    assert.ok(page.ok);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].body.run_js, true);
    assert.equal(calls[1].body.location, undefined);
    assert.deepEqual(page.steps, ['plain: empty', 'run_js: ok']);
  });

  it('treats a skeletal page like an empty one', async () => {
    const { client, calls } = setup([scrapeOk('Loading...'), scrapeOk(LONG_PAGE)]);
    assert.ok((await client.readPage('https://example.com/a')).ok);
    assert.equal(calls[1].body.run_js, true);
  });

  it('on a country TLD, retries a third time with run_js and that country', async () => {
    const { client, calls } = setup([scrapeOk(null), scrapeOk('x'), scrapeOk(LONG_PAGE)]);
    const page = await client.readPage('https://shop.example.lt/produktas');
    assert.ok(page.ok);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[2].body, { url: 'https://shop.example.lt/produktas', output: ['markdown'], location: 'LT', run_js: true });
  });

  it('reports the page as unreadable after the third attempt', async () => {
    const { client, calls } = setup([scrapeOk(null)]);
    const page = await client.readPage('https://shop.example.co.uk/x');
    assert.equal(page.ok, false);
    assert.equal(calls.length, 3);
    assert.equal(calls[2].body.location, 'GB');
    assert.match((page as { reason: string }).reason, /unreadable/);
  });

  it('stops after two attempts for .com and brand-use TLDs, with no location retry', async () => {
    for (const url of ['https://example.com/a', 'https://example.io/a', 'https://example.ai/a', 'https://example.co/a', 'https://example.me/a']) {
      const { client, calls } = setup([scrapeOk(null)]);
      const page = await client.readPage(url);
      assert.equal(page.ok, false, url);
      assert.equal(calls.length, 2, url);
      assert.ok(calls.every((c) => c.body.location === undefined), url);
    }
  });

  it('reports a failed scrape out loud instead of dropping it, but still throws on 401', async () => {
    const failing = setup([problem(404, 'NOT_FOUND')]);
    const page = await failing.client.readPage('https://example.com/dead');
    assert.equal(page.ok, false);
    assert.match((page as { reason: string }).reason, /404/);

    const unauthorised = setup([problem(401, 'UNAUTHORIZED')]);
    await assert.rejects(unauthorised.client.readPage('https://example.com/a'), OxylabsAuthError);
  });
});

describe('countryForUrl', () => {
  it('maps country TLDs and skips brand-use ones', () => {
    assert.equal(countryForUrl('https://a.lt/x'), 'LT');
    assert.equal(countryForUrl('https://a.es/x'), 'ES');
    assert.equal(countryForUrl('https://a.co.uk/x'), 'GB');
    assert.equal(countryForUrl('https://a.fi/x'), 'FI');
    for (const tld of ['io', 'ai', 'co', 'me', 'com', 'eu', 'org']) assert.equal(countryForUrl(`https://a.${tld}/x`), null, tld);
    assert.equal(countryForUrl('not a url'), null);
  });
});
