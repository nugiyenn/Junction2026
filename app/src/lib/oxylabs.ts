import 'server-only';

/**
 * Oxylabs Web API client: live search and page reading.
 * Spec: https://developers.oxylabs.io/products/web-api/for-agents.md
 *
 * Search finds which pages hold an answer; scrape reads them. Search outlines are truncated, so they
 * locate sources and are never used as the answer. Every result keeps its URL and `requestId`.
 */

const API = 'https://webapi.oxylabs.io';
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
/** A scrape renders a real page, so a short timeout fails work that would have succeeded. */
const TIMEOUT_MS = 150_000;
/** A page whose markdown is shorter than this is treated as an unrendered shell. */
const SKELETAL_CHARS = 200;
/** Country-code TLDs that are brand names, not countries. `.eu` is a region, not a country. */
const BRAND_TLDS = new Set(['io', 'ai', 'co', 'me', 'tv', 'fm', 'ly', 'gg', 'cc', 'eu']);

// --- Errors -----------------------------------------------------------------

// Plain fields, not constructor parameter properties: Node's built-in TypeScript support, used by the
// smoke and test scripts, cannot strip those.
export class OxylabsError extends Error {
  status?: number;
  /** The API's error code from the problem body, e.g. VALIDATION_ERROR. Branch on this, never on the prose. */
  title?: string;
  requestId?: string;

  constructor(message: string, status?: number, title?: string, requestId?: string) {
    super(message);
    this.name = 'OxylabsError';
    this.status = status;
    this.title = title;
    this.requestId = requestId;
  }
}

/** 401: the key is missing or rejected. Retrying cannot help; tell the user. */
export class OxylabsAuthError extends OxylabsError {
  constructor(requestId?: string) {
    super('Oxylabs rejected the API key (401). Check OXYLABS_WEB_API_KEY; a key for another Oxylabs product also gives 401.', 401, undefined, requestId);
    this.name = 'OxylabsAuthError';
  }
}

/** 400, or a request we refused to send. Names the field. Never retried unchanged. */
export class OxylabsValidationError extends OxylabsError {
  constructor(message: string, status?: number, title?: string, requestId?: string) {
    super(message, status, title, requestId);
    this.name = 'OxylabsValidationError';
  }
}

// --- Types ------------------------------------------------------------------

export interface SearchHit {
  title: string;
  url: string;
  /** Truncated snippet lines. Locates the source; never quote it as the answer. */
  outline: string[];
  position: number | null;
}

export interface SearchResponse {
  results: SearchHit[];
  requestId: string | null;
}

export interface ScrapeOptions {
  /** Two-letter country code to fetch the page from. */
  location?: string;
  /** Run the page's JavaScript. Slow, so only for pages that came back empty. */
  runJs?: boolean;
}

export interface ScrapeResponse {
  /** Final URL after redirects. */
  url: string;
  markdown: string | null;
  requestId: string | null;
}

export type ReadPageResult =
  | { ok: true; url: string; finalUrl: string; markdown: string; requestId: string | null; steps: string[] }
  | { ok: false; url: string; reason: string; steps: string[] };

export interface OxylabsDeps {
  fetch?: typeof fetch;
  /** Waits between retries. Replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  apiKey?: () => string;
  log?: (message: string) => void;
}

// --- Client -----------------------------------------------------------------

export function createOxylabs(deps: OxylabsDeps = {}) {
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = deps.random ?? Math.random;
  const log = deps.log ?? ((m: string) => console.info(m));
  const getKey =
    deps.apiKey ??
    (() => {
      const key = process.env.OXYLABS_WEB_API_KEY?.trim();
      if (!key) throw new Error('Missing OXYLABS_WEB_API_KEY: cannot call oxylabs');
      return key;
    });

  /** Strips the key from any text before it can reach a log or an error. */
  const redact = (text: string, key: string) => (key ? text.split(key).join('[redacted]') : text);

  async function post<T>(path: string, payload: unknown): Promise<T> {
    const key = getKey();
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let res: Response;
      try {
        res = await doFetch(`${API}${path}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        const name = (err as Error).name;
        if (name !== 'TimeoutError' && name !== 'AbortError') throw err;
        if (attempt === MAX_ATTEMPTS) {
          throw new OxylabsError(`${path} timed out after ${MAX_ATTEMPTS} attempts`);
        }
        await sleep(2 ** attempt * 1000 + random() * 1000);
        continue;
      }

      const text = await res.text();
      let body: Record<string, unknown> | null = null;
      try {
        body = JSON.parse(text);
      } catch {
        /* not JSON; handled below */
      }
      const requestId = ((body?.metadata as { request_id?: string } | undefined)?.request_id as string | undefined) ?? undefined;
      if (requestId) log(`[oxylabs] ${path} request_id=${requestId} status=${res.status}`);

      if (res.ok) return (body ?? {}) as T;

      if (res.status === 401) throw new OxylabsAuthError(requestId);

      const title = typeof body?.title === 'string' ? body.title : undefined;
      if (res.status === 400) {
        const fields = ((body?.errors as { pointer?: string; detail?: string }[] | undefined) ?? [])
          .map((e) => `${e.pointer ?? 'request'}: ${e.detail ?? 'invalid'}`)
          .join('; ');
        throw new OxylabsValidationError(
          redact(`${path} rejected the request (400 ${title ?? ''}): ${fields || text.slice(0, 200)}`, key),
          400,
          title,
          requestId
        );
      }

      if (!RETRYABLE.has(res.status)) {
        throw new OxylabsError(redact(`${path} -> ${res.status} ${title ?? ''}: ${text.slice(0, 200)}`, key), res.status, title, requestId);
      }
      if (attempt === MAX_ATTEMPTS) {
        const quota =
          res.status === 429 ? ' Rate limit or spent quota: if it persists, check the Oxylabs plan instead of retrying.' : '';
        throw new OxylabsError(
          redact(`${path} -> ${res.status} ${title ?? ''} after ${MAX_ATTEMPTS} attempts.${quota}`, key),
          res.status,
          title,
          requestId
        );
      }
      await sleep(2 ** attempt * 1000 + random() * 1000); // jitter: no lockstep retries
    }
    throw new OxylabsError('unreachable');
  }

  function checkLocation(location: string | undefined): string | undefined {
    if (location === undefined) return undefined;
    if (!/^[A-Za-z]{2}$/.test(location)) {
      throw new OxylabsValidationError(`location must be an ISO 3166-1 alpha-2 country code, got "${location}"`);
    }
    return location.toUpperCase();
  }

  /** One question per search. `maxResults` 1-20. */
  async function search(query: string, options: { maxResults?: number; location?: string } = {}): Promise<SearchResponse> {
    const maxResults = options.maxResults ?? 10;
    if (query.length < 1 || query.length > 2048) {
      throw new OxylabsValidationError(`query must be 1-2048 characters, got ${query.length}`);
    }
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 20) {
      throw new OxylabsValidationError(`max_results must be an integer from 1 to 20, got ${maxResults}`);
    }
    const location = checkLocation(options.location);

    const body = await post<{
      results?: { title?: string; url?: string; outline?: string[]; metadata?: { position?: number } }[];
      metadata?: { request_id?: string };
    }>('/v1/search', { query, max_results: maxResults, ...(location ? { location } : {}) });

    return {
      results: (body.results ?? [])
        .filter((r): r is typeof r & { url: string } => typeof r.url === 'string')
        .map((r) => ({
          title: r.title ?? r.url,
          url: r.url,
          outline: r.outline ?? [],
          position: r.metadata?.position ?? null,
        })),
      requestId: body.metadata?.request_id ?? null,
    };
  }

  /** Reads one page as markdown. The fields vary by target, so the response is read defensively. */
  async function scrape(url: string, options: ScrapeOptions = {}): Promise<ScrapeResponse> {
    if (!/^https?:\/\//i.test(url)) throw new OxylabsValidationError(`url must be an absolute http(s) URL, got "${url}"`);
    const location = checkLocation(options.location);

    const body = await post<{
      results?: { url?: string; markdown?: string | null }[];
      metadata?: { request_id?: string };
    }>('/v1/scrape', {
      url,
      output: ['markdown'],
      ...(location ? { location } : {}),
      ...(options.runJs ? { run_js: true } : {}),
    });

    const first = body.results?.[0];
    return {
      url: first?.url ?? url,
      markdown: typeof first?.markdown === 'string' ? first.markdown : null,
      requestId: body.metadata?.request_id ?? null,
    };
  }

  /**
   * Reads a page, following the documented ladder for empty or skeletal results:
   * 1. plain scrape; 2. retry once with run_js; 3. if the site is on a country TLD, retry once more with
   * run_js and that country as location; otherwise report the page as unreadable.
   * A failure is returned as `{ ok: false, reason }`, never dropped. 401 still throws.
   */
  async function readPage(url: string): Promise<ReadPageResult> {
    const steps: string[] = [];
    const country = countryForUrl(url);
    const attempts: ScrapeOptions[] = [{}, { runJs: true }, ...(country ? [{ runJs: true, location: country }] : [])];

    let reason = 'empty';
    for (const options of attempts) {
      const label = options.runJs ? `run_js${options.location ? ` + location ${options.location}` : ''}` : 'plain';
      try {
        const page = await scrape(url, options);
        if (page.markdown && page.markdown.trim().length >= SKELETAL_CHARS) {
          steps.push(`${label}: ok`);
          return { ok: true, url, finalUrl: page.url, markdown: page.markdown, requestId: page.requestId, steps };
        }
        steps.push(`${label}: ${page.markdown ? 'skeletal' : 'empty'}`);
        reason = page.markdown ? 'skeletal' : 'empty';
      } catch (err) {
        if (err instanceof OxylabsAuthError) throw err;
        steps.push(`${label}: ${(err as Error).message.slice(0, 120)}`);
        reason = (err as Error).message;
        if (err instanceof OxylabsValidationError) break; // never retry a rejected request
      }
    }
    return { ok: false, url, reason: `unreadable (${reason})`, steps };
  }

  return { search, scrape, readPage };
}

/** `.lt` -> LT, `.co.uk` -> GB. Brand-use and non-country TLDs give null. */
export function countryForUrl(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  const tld = host.split('.').pop() ?? '';
  if (tld.length !== 2 || BRAND_TLDS.has(tld)) return null;
  return tld === 'uk' ? 'GB' : tld.toUpperCase();
}

// --- Default instance (created on first use, like the other service clients) --

let client: ReturnType<typeof createOxylabs> | undefined;
const getClient = () => (client ??= createOxylabs());

export const searchWeb = (...args: Parameters<ReturnType<typeof createOxylabs>['search']>) => getClient().search(...args);
export const scrapePage = (...args: Parameters<ReturnType<typeof createOxylabs>['scrape']>) => getClient().scrape(...args);
export const readPage = (...args: Parameters<ReturnType<typeof createOxylabs>['readPage']>) => getClient().readPage(...args);
