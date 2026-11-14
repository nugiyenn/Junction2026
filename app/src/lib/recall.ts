import 'server-only';
import { z } from 'zod';
import { logAudit } from '@/lib/audit';
import { getPool } from '@/lib/db';
import { HttpError } from '@/lib/http';
import { runOpenModelStructured } from '@/lib/llm';
import { OxylabsAuthError, OxylabsError, readPage, searchWeb } from '@/lib/oxylabs';
import { runRecallCheck } from '@/lib/recall-core';
import type { Product, RecallCheck, RecallMatch, VerificationSource } from '@/types';

/** A check younger than this is reused instead of spending another live call. */
const FRESH_HOURS = 24;
const PAGE_CHARS = 12_000;

const Extraction = z.object({
  recalls: z.array(z.object({ text: z.string(), evidence: z.string() })).max(5),
});

interface RecallRow {
  product_id: string;
  checked_at: Date;
  status: RecallCheck['status'];
  matches: RecallMatch[];
  sources: VerificationSource[];
  query: string;
  search_request_id: string | null;
  summary: string;
  model: string | null;
}

const toRecallCheck = (r: RecallRow): RecallCheck => ({
  productId: r.product_id,
  checkedAt: r.checked_at.toISOString(),
  status: r.status,
  matches: r.matches,
  sources: r.sources,
  query: r.query,
  searchRequestId: r.search_request_id,
  summary: r.summary,
  model: r.model,
});

/** Stored checks only, no live calls: used when an order is judged. */
export async function getRecallChecks(productIds: string[]): Promise<Map<string, RecallCheck>> {
  const { rows } = await getPool().query<RecallRow>('SELECT * FROM recall_checks WHERE product_id = ANY($1::text[])', [productIds]);
  return new Map(rows.map((r) => [r.product_id, toRecallCheck(r)]));
}

async function extract(page: string, product: Product) {
  const { output, model } = await runOpenModelStructured(
    `You read one recall notice from the Finnish Food Authority (Ruokavirasto, in Finnish) and decide whether it recalls this product.
The product is: ${product.nameFi}${product.nameEn ? ` / ${product.nameEn}` : ''}${product.brand ? `, brand ${product.brand}` : ''}${product.gtin ? `, GTIN ${product.gtin}` : ''}.
Return {"recalls": [...]}. Add an entry only when the notice recalls this product itself: the same brand and the same kind of product, or its GTIN.
A recall of another product, even from the same maker, or of another pack size or EAN than this product's, gives {"recalls": []}. Each entry has:
- "text": one short sentence in English: what the recall is for.
- "evidence": a passage COPIED EXACTLY from the page, 12 to 300 characters, that names the recalled product or brand. Never paraphrase it.`,
    `Page text:\n${page.slice(0, PAGE_CHARS)}`,
    Extraction,
    { gemmaDeadlineMs: 60_000, skipScope: 'pages' }
  );
  return { recalls: output.recalls, model };
}

/**
 * Looks for a recall notice about a product on the Finnish Food Authority's site: Oxylabs search finds notices, the
 * best ones are read, a model extracts a match with a quote, and code keeps it only when the quote is on the page and
 * names the product or brand. "None found" is stored with the sources searched. Reused for 24 hours.
 */
export async function checkRecalls(product: Product, options: { force?: boolean } = {}): Promise<RecallCheck> {
  if (!options.force) {
    const { rows } = await getPool().query<RecallRow>(
      'SELECT * FROM recall_checks WHERE product_id = $1 AND checked_at > now() - make_interval(hours => $2)',
      [product.id, FRESH_HOURS]
    );
    if (rows.length > 0) return toRecallCheck(rows[0]);
  }

  let outcome;
  try {
    outcome = await runRecallCheck(product, { search: searchWeb, read: readPage, extract });
  } catch (err) {
    if (err instanceof OxylabsAuthError || err instanceof OxylabsError) throw new HttpError(502, `Oxylabs: ${err.message}`);
    throw err;
  }

  const { rows } = await getPool().query<RecallRow>(
    `INSERT INTO recall_checks (product_id, checked_at, status, matches, sources, query, search_request_id, summary, model)
     VALUES ($1, now(), $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (product_id) DO UPDATE SET checked_at = now(), status = EXCLUDED.status, matches = EXCLUDED.matches,
       sources = EXCLUDED.sources, query = EXCLUDED.query, search_request_id = EXCLUDED.search_request_id, summary = EXCLUDED.summary,
       model = EXCLUDED.model
     RETURNING *`,
    [product.id, outcome.status, JSON.stringify(outcome.matches), JSON.stringify(outcome.sources), outcome.query, outcome.searchRequestId, outcome.summary, [...new Set(outcome.models)].join(', ') || null]
  );

  await logAudit({
    actor: 'agent',
    action: 'recall_checked',
    mandateId: null,
    quoteId: null,
    orderId: null,
    summary: `Searched Ruokavirasto recall notices for "${product.nameEn ?? product.nameFi}" (${outcome.sources.filter((s) => s.readable).length} notice(s) read${outcome.models.length ? `, read by ${[...new Set(outcome.models)].join(', ')}` : ''}): ${outcome.summary}`,
    data: {
      productId: product.id,
      status: outcome.status,
      query: outcome.query,
      sourceUrls: outcome.sources.map((s) => s.url),
      requestIds: [outcome.searchRequestId, ...outcome.sources.map((s) => s.requestId)].filter(Boolean),
    },
  });

  return toRecallCheck(rows[0]);
}
