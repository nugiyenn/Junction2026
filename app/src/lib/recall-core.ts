import type { Product, RecallCheck, RecallMatch, VerificationSource } from '../types/index.ts';
import type { ReadPageResult, SearchResponse } from './oxylabs.ts';
import { evidenceAppears, isNotFoundPage, namesProduct, recallNoticeUrls } from './evidence.ts';

// The recall check without the database, the audit trail or the real clients, so tests can drive it with mocked
// Oxylabs and model transports. recall.ts wires in the real ones.

/** Recall notices read per product. Search finds them; reading every result costs more for a worse answer. */
const NOTICES_PER_PRODUCT = 3;

export interface RecallDeps {
  search: (query: string, options: { maxResults: number; location: string }) => Promise<SearchResponse>;
  read: (url: string) => Promise<ReadPageResult>;
  /** The model's reading of one notice: recalls it thinks concern the product, each with a passage copied from the page. */
  extract: (page: string, product: Product) => Promise<{ recalls: { text: string; evidence: string }[]; model: string }>;
}

export type RecallOutcome = Omit<RecallCheck, 'productId' | 'checkedAt'> & { models: string[] };

/** `site:` keeps the search on Ruokavirasto; the brand and the first words of the Finnish name find notices about this product. */
export function recallQuery(product: Pick<Product, 'nameFi' | 'brand'>): string {
  const name = product.nameFi.split(/\s+/).filter((w) => /^\p{L}[\p{L}\p{N}®-]*$/u.test(w) && w.length > 2 && w.toLowerCase() !== product.brand?.toLowerCase());
  return `site:ruokavirasto.fi takaisinveto ${product.brand ?? ''} ${name.slice(0, 4).join(' ')}`.replace(/\s+/g, ' ').trim();
}

/**
 * Searches Ruokavirasto's recall notices for a product, reads the best notice pages, and keeps only a model's match
 * whose quote is really on that page and names the product or brand. "None found" still carries the query, the
 * Oxylabs request ids and the search results as proof of what was searched.
 */
export async function runRecallCheck(product: Product, deps: RecallDeps): Promise<RecallOutcome> {
  const query = recallQuery(product);
  const search = await deps.search(query, { maxResults: 8, location: 'FI' });
  const notices = recallNoticeUrls(search.results, NOTICES_PER_PRODUCT);

  const sources: VerificationSource[] = search.results
    .filter((h) => !notices.includes(h.url))
    .map((h) => ({ url: h.url, title: h.title, requestId: null, readable: false, note: 'Search result that is not a recall notice; not read.' }));
  const matches: RecallMatch[] = [];
  const models: string[] = [];

  const reads = await Promise.all(notices.map(async (url) => ({ url, page: await deps.read(url) })));
  for (const { url, page } of reads) {
    const title = search.results.find((h) => h.url === url)?.title ?? url;
    if (!page.ok) {
      sources.unshift({ url, title, requestId: null, readable: false, note: page.reason });
      continue;
    }
    if (isNotFoundPage(page.markdown)) {
      sources.unshift({ url, title, requestId: page.requestId, readable: false, note: 'The notice has been removed or moved (404).' });
      continue;
    }
    const found = await deps.extract(page.markdown, product);
    models.push(found.model);
    // The quote must be on the page and name the product or brand, or the match is dropped.
    const kept = found.recalls.filter((r) => evidenceAppears(r.evidence, page.markdown) && namesProduct(r.evidence, product));
    matches.push(...kept.map((r) => ({ sourceUrl: url, quote: r.evidence, text: r.text })));
    sources.unshift({ url, title, requestId: page.requestId, readable: true, note: kept.length ? 'Recall notice naming this product.' : 'Recall notice read; it does not concern this product.' });
  }

  const readable = sources.filter((s) => s.readable).length;
  // A notice that has been removed (404) is not a live recall, so it counts as unreadable only when others failed too.
  const removed = sources.filter((s) => s.note?.includes('(404)')).length;
  const status: RecallCheck['status'] =
    matches.length > 0 ? 'match' : notices.length > removed && readable === 0 ? 'unreadable' : 'none_found';
  const summary = {
    match: `A Ruokavirasto recall notice names this product or its brand: "${matches[0]?.quote.replace(/\s+/g, ' ')}" (${matches[0]?.sourceUrl}).`,
    unreadable: `${notices.length} Ruokavirasto recall notice(s) were found but none could be read.`,
    none_found: `No current recall notice for this product found on Ruokavirasto (${notices.length ? `${readable} notice(s) read${removed ? `, ${removed} removed` : ''}` : 'search returned no recall notice page'}).`,
  }[status];

  return { status, matches, sources, query, searchRequestId: search.requestId, summary, models };
}
