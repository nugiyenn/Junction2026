import 'server-only';
import { catalogVocabulary, searchProducts } from '@/lib/catalog';
import { withTimeout } from '@/lib/deadline';
import { HttpError } from '@/lib/http';
import { packQuantity } from '@/lib/packs';
import { mapLimit } from '@/lib/pool';
import { buildQuoteLine } from '@/lib/purchasing';
import { toRecipeProduct } from '@/lib/recipe-product';
import { isNotOrdered, matchStatus, orderByOrderability, prefixTerms, rankProducts, searchQuery, type Scored } from '@/lib/recipe-score';
import { getAvailability, getPrices } from '@/lib/valio';
import type {
  Mandate,
  ProductSearchResult,
  RecipeLine,
  RecipeLineMatch,
  RecipeProduct,
  RecipeUnit,
  ValioProductAvailability,
  ValioProductPrice,
} from '@/types';

/** Catalog search runs for three lines at a time: the database pool holds three connections. */
const SEARCH_CONCURRENCY = 3;
/** Valio's price and availability calls: two chunks at a time, two calls each, so four calls in flight at most. */
const VALIO_CHUNK_CONCURRENCY = 2;
/** Lines per Valio call: price and availability are asked for a handful of lines' candidates at once. */
const LINES_PER_VALIO_CALL = 4;
/** Candidates priced per line. Three are shown (the proposal and two alternatives), chosen from these so that one Valio can deliver is not missed. */
const CANDIDATES = 5;
const ALTERNATIVES = 2;
/** Search results ranked per line before the best three are kept. */
const SEARCH_POOL = 30;
/** The whole match step, search and Valio, may take this long. What is not done by then is reported as such. */
export const MATCH_BUDGET_MS = 60_000;

class MatchTimeout extends Error {}

interface LineState {
  /** The best candidates, ranked. Null when the search itself failed. */
  candidates: Scored<ProductSearchResult>[] | null;
  /** Matching products the mandate's blocked allergens removed. */
  excluded: number;
  /** Set when Valio did not answer for this line's chunk. */
  valioError: string | null;
  /** True once Valio answered for this line's chunk. False after a timeout. */
  valioAnswered: boolean;
}

const plainValioError = (err: unknown) =>
  err instanceof HttpError && err.status === 429
    ? "Valio's price service is busy. Try again in a moment."
    : "Valio's price service did not answer for this line.";

const isPriced = (price: ValioProductPrice | undefined) => Boolean(price && !price.error && price.catalogPrice);

/** A product with Valio's answer turned into what the buyer sees: pack size, packs, price and whether it can be filled. */
function proposalFor(
  product: ProductSearchResult,
  line: Pick<RecipeLine, 'unit'>,
  amount: number,
  deliveryDate: string,
  price: ValioProductPrice | undefined,
  avail: ValioProductAvailability | undefined,
  now: number
): { proposal: RecipeProduct; converted: boolean } {
  // Liquids are written in kilos and sold by the litre (and the other way round): count 1 kg as 1 litre, and say so.
  const sold = price?.comparisonUnit;
  const converted = line.unit !== 'unit' && (sold === 'KG' || sold === 'L') && sold !== line.unit;
  const unit: RecipeUnit = converted ? (sold as RecipeUnit) : line.unit;
  const pack = packQuantity(price, amount, unit, product.allowedLotSize);
  const quoteLine = buildQuoteLine(product, pack.quantity ?? 1, deliveryDate, price, avail, now);
  return { converted, proposal: toRecipeProduct(product, quoteLine, pack, unit) };
}

/**
 * Finds a product for every recipe line. No model is involved: the catalog search (keyword and meaning) finds
 * candidates, word overlap ranks them, Valio's price answer sizes the packs, and the same fulfilment checks as a quote
 * run on each. Lines that cannot be matched or priced in time are reported as such; the others still return.
 * `multiplier` is the portions factor: every amount is multiplied by it before the packs are sized.
 */
export async function matchRecipe(
  lines: RecipeLine[],
  options: { mandate: Mandate; deliveryDate: string; multiplier: number; budgetMs?: number }
): Promise<RecipeLineMatch[]> {
  const { mandate, deliveryDate, multiplier } = options;
  const states: LineState[] = lines.map(() => ({ candidates: [], excluded: 0, valioError: null, valioAnswered: false }));
  const prices = new Map<string, ValioProductPrice>();
  const availability = new Map<string, ValioProductAvailability>();
  let cancelled = false;

  const work = async () => {
    // 1. Catalog search per line. The catalog's own words let a Finnish compound ("kasvisliemijauhe") match its parts.
    const vocabulary = await catalogVocabulary().catch(() => undefined);
    await mapLimit(lines, SEARCH_CONCURRENCY, async (line, i) => {
      if (cancelled || isNotOrdered(line.name)) return;
      try {
        const search = () =>
          searchProducts(searchQuery(line), { excludeAllergens: mandate.blockedAllergens }, SEARCH_POOL, prefixTerms(line, vocabulary));
        // One more try: a busy database can refuse a connection for a moment.
        const { products, excludedByAllergens } = await search().catch(() => search());
        states[i].candidates = rankProducts(line, products, vocabulary).slice(0, CANDIDATES);
        states[i].excluded = excludedByAllergens;
      } catch (err) {
        console.warn('Recipe line search failed:', err instanceof Error ? err.message.slice(0, 160) : err);
        states[i].candidates = null;
      }
    });

    // 2. Price and availability for the candidates, in small batches.
    const indexes = lines.map((_, i) => i).filter((i) => (states[i].candidates?.length ?? 0) > 0);
    const chunks: number[][] = [];
    for (let at = 0; at < indexes.length; at += LINES_PER_VALIO_CALL) chunks.push(indexes.slice(at, at + LINES_PER_VALIO_CALL));
    await mapLimit(chunks, VALIO_CHUNK_CONCURRENCY, async (chunk) => {
      if (cancelled) return;
      const ids = [...new Set(chunk.flatMap((i) => states[i].candidates!.map((c) => c.product.id)))];
      try {
        const [priceAnswer, availabilityAnswer] = await Promise.all([getPrices(ids, deliveryDate), getAvailability(ids, deliveryDate)]);
        for (const p of priceAnswer.products) prices.set(p.productId, p);
        for (const a of availabilityAnswer.products) availability.set(a.productId, a);
        for (const i of chunk) states[i].valioAnswered = true;
      } catch (err) {
        for (const i of chunk) states[i].valioError = plainValioError(err);
      }
    });
  };

  try {
    await withTimeout(work(), options.budgetMs ?? MATCH_BUDGET_MS, () => new MatchTimeout());
  } catch (err) {
    if (!(err instanceof MatchTimeout)) throw err;
  } finally {
    cancelled = true;
  }

  const now = Date.now();
  return lines.map((line, index): RecipeLineMatch => {
    const state = states[index];
    const amount = Number((line.amount * multiplier).toPrecision(8));
    const base = { index, raw: line.raw, name: line.name, ...(line.link ? { link: line.link } : {}), readBy: line.readBy ?? ('code' as const), baseAmount: line.amount, amount, unit: line.unit };

    if (isNotOrdered(line.name)) {
      return { ...base, status: 'not_found', notOrdered: true, note: 'Water and ice are not ordered from Valio.', proposal: null, alternatives: [] };
    }
    if (state.candidates === null) {
      return { ...base, status: 'unpriced', note: 'The catalog search failed for this line. Try again.', proposal: null, alternatives: [] };
    }
    if (state.candidates.length === 0) {
      return { ...base, status: 'not_found', note: notFoundNote(state.excluded), proposal: null, alternatives: [] };
    }

    // Candidates that really are the line's product, best fit first.
    const hasLink = Boolean(line.link);
    const statusOf = (c: Scored<ProductSearchResult>) => matchStatus(c.fit, c.product.similarity, hasLink, c.precision);
    const usable = state.candidates.filter((c) => statusOf(c) !== 'not_found');
    if (usable.length === 0) {
      return { ...base, status: 'not_found', note: notFoundNote(state.excluded), proposal: null, alternatives: [] };
    }
    const built = usable.map((c) => ({
      c,
      ...proposalFor(c.product, line, amount, deliveryDate, prices.get(c.product.id), availability.get(c.product.id), now),
    }));
    // A product Valio can size and deliver comes before one it cannot, when it matches about as well.
    const ordered = orderByOrderability(built, (x) => ({
      score: x.c.score,
      matched: statusOf(x.c) === 'matched',
      sized: x.proposal.quantity !== null,
      deliverable: x.proposal.fulfillable,
    }));

    // Other products must share words with the line: a meaning-only match may be proposed, but not offered as a second choice.
    const [first, ...others] = ordered;
    const rest = others.filter((x) => x.c.fit >= 0.3).slice(0, ALTERNATIVES);
    const fit = statusOf(first.c);
    const price = prices.get(first.c.product.id);
    const notes: string[] = [];
    let status: RecipeLineMatch['status'] = fit;
    if (first.proposal.quantity === null) {
      status = 'unpriced';
      notes.push(
        !isPriced(price)
          ? (state.valioError ?? (state.valioAnswered ? 'Valio gave no price for this product.' : 'Could not be priced in time.'))
          : 'Valio gave no price per kilo or litre, so the packs cannot be worked out.'
      );
      if (fit === 'weak') notes.push('The product also fits only partly.');
    } else if (fit === 'weak') {
      notes.push('Fits only partly: check the product before ordering.');
    }
    notes.push(...first.c.caveats);
    if (first.converted) notes.push(`Sold per ${first.proposal.packUnit === 'L' ? 'litre' : 'kilo'}: ${line.unit === 'KG' ? '1 kg counted as 1 litre' : '1 litre counted as 1 kg'}.`);

    return {
      ...base,
      status,
      note: notes.length > 0 ? notes.join(' ') : null,
      proposal: first.proposal,
      alternatives: rest.map((r) => r.proposal),
    };
  });
}

const notFoundNote = (excluded: number) =>
  excluded > 0
    ? `Not found in Valio's range. ${excluded} matching product${excluded === 1 ? ' was' : 's were'} left out because of the allergens this mandate blocks.`
    : "Not found in Valio's range.";
