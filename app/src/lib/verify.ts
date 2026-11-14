import 'server-only';
import { z } from 'zod';
import { logAudit } from '@/lib/audit';
import { getProductsByIds } from '@/lib/catalog';
import { getPool } from '@/lib/db';
import { ALLERGEN_CODES, compareWithCatalog, evidenceAppears, pageMatchesProduct } from '@/lib/evidence';
import { HttpError } from '@/lib/http';
import { runExtractionModelStructured } from '@/lib/llm';
import { OxylabsAuthError, OxylabsError, readPage, searchWeb } from '@/lib/oxylabs';
import type { Product, Verification, VerificationSource, VerifiedStatement } from '@/types';

/** Pages read per product. Search finds sources; reading every result costs more for a worse answer. */
const PAGES_PER_PRODUCT = 2;
/** A check younger than this is reused instead of spending another live call. */
const FRESH_HOURS = 24;
const PAGE_CHARS = 12_000;

const Extraction = z.object({
  statements: z
    .array(
      z.object({
        topic: z.enum(['allergen', 'label', 'ingredient', 'origin']),
        stance: z.enum(['contains', 'may_contain', 'free_from']).nullable().optional(),
        allergen: z.string().nullable().optional(),
        text: z.string(),
        evidence: z.string(),
      })
    )
    .max(20),
});

interface VerificationRow {
  product_id: string;
  checked_at: Date;
  status: Verification['status'];
  statements: VerifiedStatement[];
  contradictions: string[];
  sources: VerificationSource[];
  search_request_id: string | null;
  summary: string;
}

const toVerification = (r: VerificationRow): Verification => ({
  productId: r.product_id,
  checkedAt: r.checked_at.toISOString(),
  status: r.status,
  statements: r.statements,
  contradictions: r.contradictions,
  sources: r.sources,
  searchRequestId: r.search_request_id,
  summary: r.summary,
});

/** Stored checks only, no live calls: used when an order is judged. */
export async function getVerifications(productIds: string[]): Promise<Map<string, Verification>> {
  const { rows } = await getPool().query<VerificationRow>('SELECT * FROM verifications WHERE product_id = ANY($1::text[])', [productIds]);
  return new Map(rows.map((r) => [r.product_id, toVerification(r)]));
}

async function extractStatements(page: string, product: Product, sourceUrl: string): Promise<{ statements: VerifiedStatement[]; model: string }> {
  const { output, model } = await runExtractionModelStructured(
    `You read one web page about a food product and extract what it says about allergens and labels.
The product is: ${product.nameEn ?? product.nameFi}${product.gtin ? ` (GTIN ${product.gtin})` : ''}.
Return {"statements": [...]}. Each statement has:
- "topic": "allergen", "label" (organic, MSC, Fair Trade, Finnish origin marks, ...), "ingredient" or "origin".
- "stance": for allergens only, "contains", "may_contain" or "free_from"; otherwise null.
- "allergen": for allergens only, one of: ${Object.keys(ALLERGEN_CODES).join(', ')}; otherwise null.
- "text": one short sentence in English.
- "evidence": a passage COPIED EXACTLY from the page, 12 to 200 characters. Never paraphrase it.
Use only what the page states about this product. If the page is about another product, return {"statements": []}.`,
    `Page text:\n${page.slice(0, PAGE_CHARS)}`,
    Extraction,
    // Page-sized input takes Gemma longer than a short request does.
    { gemmaDeadlineMs: 60_000 }
  );

  const statements: VerifiedStatement[] = [];
  for (const s of output.statements) {
    // The model's quote must really be on the page, or the statement is dropped.
    if (!evidenceAppears(s.evidence, page)) continue;
    const code = s.allergen ? ALLERGEN_CODES[s.allergen.toLowerCase().trim()] ?? null : null;
    statements.push({
      topic: s.topic,
      stance: s.topic === 'allergen' ? (s.stance ?? null) : null,
      allergen: s.topic === 'allergen' ? code : null,
      text: s.text,
      evidence: s.evidence,
      sourceUrl,
    });
  }
  return { statements, model };
}

/**
 * Checks a product's allergen and label claims against the live web: Oxylabs search finds sources, the top pages
 * are read, a model extracts statements with quotes, and code keeps only quotes that are on the page and pages
 * that are about this product. A check is stored and reused for 24 hours.
 */
export async function verifyProduct(productId: string, options: { force?: boolean } = {}): Promise<Verification> {
  const product = (await getProductsByIds([productId])).get(productId);
  if (!product) throw new HttpError(404, `Unknown product: ${productId}`);

  if (!options.force) {
    const { rows } = await getPool().query<VerificationRow>(
      `SELECT * FROM verifications WHERE product_id = $1 AND checked_at > now() - make_interval(hours => $2)`,
      [productId, FRESH_HOURS]
    );
    if (rows.length > 0) return toVerification(rows[0]);
  }

  const name = product.nameEn ?? product.nameFi;
  let search;
  try {
    search = await searchWeb(`"${name}" ${product.gtin ?? ''} allergens ingredients`.trim(), { maxResults: 5 });
  } catch (err) {
    if (err instanceof OxylabsAuthError || err instanceof OxylabsError) throw new HttpError(502, `Oxylabs: ${err.message}`);
    throw err;
  }

  const hits = search.results.slice(0, PAGES_PER_PRODUCT);
  const pages = await Promise.all(
    hits.map(async (hit) => {
      try {
        return { hit, page: await readPage(hit.url) };
      } catch (err) {
        if (err instanceof OxylabsAuthError) throw new HttpError(502, `Oxylabs: ${err.message}`);
        throw err;
      }
    })
  );

  const sources: VerificationSource[] = [];
  const statements: VerifiedStatement[] = [];
  let model = '';
  await Promise.all(
    pages.map(async ({ hit, page }) => {
      if (!page.ok) {
        sources.push({ url: hit.url, title: hit.title, requestId: null, readable: false, note: page.reason });
      } else if (!pageMatchesProduct(page.markdown, product)) {
        sources.push({ url: hit.url, title: hit.title, requestId: page.requestId, readable: true, note: 'Page is not about this product.' });
      } else {
        const found = await extractStatements(page.markdown, product, hit.url);
        statements.push(...found.statements);
        model = found.model;
        sources.push({ url: hit.url, title: hit.title, requestId: page.requestId, readable: true, note: found.statements.length ? null : 'No verifiable statement on the page.' });
      }
    })
  );

  const contradictions = compareWithCatalog(statements, product);
  const readable = sources.filter((s) => s.readable).length;
  const status: Verification['status'] =
    contradictions.length > 0 ? 'contradiction' : statements.length > 0 ? 'confirmed' : readable === 0 ? 'unreadable' : 'no_evidence';
  const summary =
    {
      contradiction: `A live source disagrees with the catalog: ${contradictions[0]}`,
      confirmed: `${statements.length} statement(s) found on ${new Set(statements.map((s) => s.sourceUrl)).size} source page(s); none contradicts the catalog.`,
      no_evidence: 'Pages were read but none had a verifiable statement about this product.',
      unreadable: 'No source page could be read.',
    }[status];

  const { rows } = await getPool().query<VerificationRow>(
    `INSERT INTO verifications (product_id, checked_at, status, statements, contradictions, sources, search_request_id, summary)
     VALUES ($1, now(), $2, $3, $4, $5, $6, $7)
     ON CONFLICT (product_id) DO UPDATE SET checked_at = now(), status = EXCLUDED.status, statements = EXCLUDED.statements,
       contradictions = EXCLUDED.contradictions, sources = EXCLUDED.sources, search_request_id = EXCLUDED.search_request_id,
       summary = EXCLUDED.summary
     RETURNING *`,
    [productId, status, JSON.stringify(statements), JSON.stringify(contradictions), JSON.stringify(sources), search.requestId, summary]
  );

  await logAudit({
    actor: 'agent',
    action: 'product_verified',
    mandateId: null,
    quoteId: null,
    orderId: null,
    summary: `Checked "${name}" against the live web (${readable} of ${sources.length} pages readable${model ? `, read by ${model}` : ''}): ${summary}`,
    data: { productId, status, sourceUrls: sources.map((s) => s.url), searchRequestId: search.requestId },
  });

  return toVerification(rows[0]);
}
