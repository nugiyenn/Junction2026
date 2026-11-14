import 'server-only';
import { z } from 'zod';
import { logAudit } from '@/lib/audit';
import { getProductsByIds, searchProducts } from '@/lib/catalog';
import { exposeQuote, sanitizeIssue } from '@/lib/exposure';
import { withTimeout } from '@/lib/deadline';
import { HttpError } from '@/lib/http';
import { compareInterpretations, helsinkiToday, interpretInstructions, PurchaseRequestSchema, quantityLineCount, weekdayDate } from '@/lib/interpret';
import { runExtractionModelStructured, runNamedModelStructured, runOpenModelStructured } from '@/lib/llm';
import { runLiveChecks } from '@/lib/live-checks';
import { applyPreference, buildOffers } from '@/lib/offers';
import { buildQuoteLine, createQuote, getMandate, previewPolicy } from '@/lib/purchasing';
import { checkRecalls } from '@/lib/recall';
import { getAvailability, getPrices } from '@/lib/valio';
import { verifyProduct } from '@/lib/verify';
import type { Candidate, InterpretationCheck, LiveChecks, Mandate, Offer, Product, ProductSearchResult, PurchaseRequest, RequestResult } from '@/types';

/** Valio asks agents to price only a narrowed-down shortlist, never the catalog. */
const SHORTLIST_SIZE = 5;

/** Live-web checks run on at most this many products, two at a time, within this time budget. */
const LIVE_CHECK_PRODUCTS = 3;
const LIVE_CHECK_CONCURRENCY = 2;
const LIVE_CHECK_BUDGET_MS = 90_000;

/** The language model only extracts the need. Everything after this is deterministic code. */
/** The second reader. In the evaluation it answered all 12 requests correctly in about 3.4 s (slowest 5.8 s). */
const SECOND_READER = { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' } as const;
const SECOND_READER_TIMEOUT_MS = 15_000;

/** Time budgets per step, so the whole request stays inside the route's 300 s even when a provider is slow or down. */
const READ_BUDGET_MS = 75_000;
const PICK_BUDGET_MS = 60_000;

/**
 * Two models read the request independently, side by side: the open-weights chain (Gemma first) and Gemini. Code compares
 * the amount, unit and delivery date, the fields it multiplies, and reports any disagreement. The first model's reading
 * is the one used. If Gemini does not answer, the request goes on and says so.
 */
export async function interpretRequest(text: string): Promise<{ request: PurchaseRequest; model: string; check: InterpretationCheck }> {
  const lines = quantityLineCount(text);
  if (lines >= 3) {
    throw new HttpError(
      422,
      `This looks like a recipe or list with ${lines} products. A request covers one product at a time: send each line as its own request, for example "20 kg of oat cooking cream by Friday".`
    );
  }
  const today = helsinkiToday();
  const instructions = interpretInstructions(today);
  // A weekday in the text is arithmetic, so code settles it for both readings.
  const byCode = weekdayDate(text, today.date);
  const settle = (r: PurchaseRequest): PurchaseRequest => (byCode !== null && byCode !== r.deliveryDate ? { ...r, deliveryDate: byCode } : r);

  const [first, second] = await Promise.allSettled([
    withTimeout(
      runOpenModelStructured(instructions, text, PurchaseRequestSchema),
      READ_BUDGET_MS,
      () => new HttpError(504, 'The models did not read the request in time. Try again.')
    ),
    runNamedModelStructured(SECOND_READER.id, instructions, text, PurchaseRequestSchema, { timeoutMs: SECOND_READER_TIMEOUT_MS }),
  ]);
  if (first.status === 'rejected') {
    const reason = first.reason;
    // A model that answered in a shape we cannot use (not JSON, a list, wrong fields) is a failed reading, not a bad request.
    // Never show the parser's own text: it is raw JSON.
    if (reason instanceof z.ZodError || reason instanceof SyntaxError) {
      throw new HttpError(502, 'The models answered in a format we could not read. Try again, or shorten and simplify the request.');
    }
    throw reason;
  }

  let request: PurchaseRequest = first.value.output;
  let model = first.value.model;
  if (byCode !== null && byCode !== request.deliveryDate) {
    request = settle(request);
    model = `${model}; delivery date set from the weekday by code`;
  }
  if (request.deliveryDate < today.date) {
    throw new HttpError(422, `Interpreted delivery date ${request.deliveryDate} is in the past.`);
  }

  const reading = (r: PurchaseRequest) => `${r.amount} ${r.amountUnit} by ${r.deliveryDate}`;
  let check: InterpretationCheck;
  if (second.status === 'fulfilled') {
    const other = settle(second.value);
    const differences = compareInterpretations(request, other);
    check = {
      status: differences.length === 0 ? 'agree' : 'disagree',
      secondModel: SECOND_READER.label,
      differences,
      detail: differences.length === 0 ? reading(other) : `${SECOND_READER.label} read ${reading(other)}; the first model read ${reading(request)}.`,
    };
  } else {
    const reason = second.reason instanceof Error ? second.reason.message : String(second.reason);
    check = { status: 'unavailable', secondModel: SECOND_READER.label, differences: [], detail: reason.slice(0, 160) };
  }
  return { request, model, check };
}

/** How many search results Gemma sees when picking the products that match the need. */
const RETRIEVE = 40;

/**
 * Search finds products that mention the words ("milk" also finds milk chocolate). Gemma picks the ones
 * that actually are the requested product. It can only choose ids from the list, and code checks that.
 */
async function pickMatches(
  request: PurchaseRequest,
  products: ProductSearchResult[]
): Promise<{ matches: ProductSearchResult[]; model: string }> {
  const ids = new Set(products.map((p) => p.id));
  // Picking from 40 catalog lines is a long prompt: Gemma did not answer it within 45 s in live runs while reading the short
  // request took about 12 s. Nemotron answers in about a second, so it picks first, and the chain (Gemma, Featherless) is its fallback.
  const {
    output: { ids: picked },
    model,
  } = await withTimeout(
    runExtractionModelStructured(
    `A food-service buyer needs: ${request.product}` +
      `${request.requiredClaims.length ? ` (${request.requiredClaims.join(', ')})` : ''}, ` +
      `ordered by ${request.amountUnit === 'unit' ? 'the piece or pack' : request.amountUnit === 'L' ? 'volume' : 'weight'}.
From the catalog lines in the input ("id: name"), choose up to ${SHORTLIST_SIZE} that ARE this product, in any brand, size or flavour.
Exclude a line only when it is a different kind of product that merely contains the item or is made from it
(for example yoghurt with granola, a chocolate drink for milk, ice cream, a baking mix).
Return {"ids": [...]}, best match first. Use only ids from the input. Return {"ids": []} if none match.`,
    products.map((p) => `${p.id}: ${p.nameEn ?? p.nameFi}`).join('\n'),
    z.object({ ids: z.array(z.union([z.string(), z.number()]).transform(String)) }),
    { skipScope: 'pick' }
    ),
    PICK_BUDGET_MS,
    () => new HttpError(504, 'The models did not pick matching products in time. Try again.')
  );
  const byId = new Map(products.map((p) => [p.id, p]));
  const matches = [...new Set(picked)].filter((id) => ids.has(id)).slice(0, SHORTLIST_SIZE).map((id) => byId.get(id)!);
  return { matches, model };
}

/** Rounds L or KG per sales unit to 2 significant figures: 19.94 L becomes 20 L, 0.497 L becomes 0.5 L. */
const roundPackSize = (n: number) => Number(n.toPrecision(2));

type Unranked = Omit<Candidate, 'rank'>;

/**
 * Live price and availability for a handful of products (never more than the shortlist), turned into
 * candidates: how many sales units cover the request, what that costs, and whether it can deliver.
 */
async function priceCandidates(
  products: Product[],
  request: PurchaseRequest,
  substituteFor: Map<string, string> = new Map()
): Promise<Unranked[]> {
  const ids = products.map((p) => p.id);
  const [prices, availability] = await Promise.all([
    getPrices(ids, request.deliveryDate),
    getAvailability(ids, request.deliveryDate),
  ]);
  const now = Date.now();

  return products.map((product): Unranked => {
    const price = prices.products.find((p) => p.productId === product.id);
    const avail = availability.products.find((p) => p.productId === product.id);
    const reasons: string[] = [];

    let amountPerUnit: number | null = null;
    if (request.amountUnit === 'unit') {
      amountPerUnit = 1;
    } else if (price?.comparisonUnit !== request.amountUnit) {
      reasons.push(`Priced per ${price?.comparisonUnit ?? 'unknown unit'}, not per ${request.amountUnit}.`);
    } else if (price.catalogPrice && price.comparisonPrice && price.comparisonPrice.value > 0) {
      amountPerUnit = roundPackSize(price.catalogPrice.value / price.comparisonPrice.value);
    } else {
      reasons.push('No price per litre or kilo to size the order with.');
    }

    let quantity: number | null = null;
    if (amountPerUnit !== null) {
      quantity = Math.ceil(request.amount / amountPerUnit);
      if (product.allowedLotSize > 1) quantity = Math.ceil(quantity / product.allowedLotSize) * product.allowedLotSize;
    }

    const line = buildQuoteLine(product, quantity ?? 1, request.deliveryDate, price, avail, now);
    if (quantity !== null) reasons.push(...line.issues);

    return {
      productId: product.id,
      name: line.name,
      quantity,
      salesUnit: line.salesUnit,
      amountPerUnit,
      unitPrice: line.unitPrice,
      comparisonPrice: line.comparisonPrice,
      comparisonUnit: line.comparisonUnit,
      total: quantity === null ? null : line.lineTotal,
      logisticModel: line.logisticModel,
      deliveryReliability: product.deliveryReliability,
      co2PerKg: product.co2PerKg,
      labels: product.labels,
      fulfillable: quantity !== null && line.fulfillable,
      availableAmount: line.availableAmount,
      allowedLotSize: product.allowedLotSize,
      // The only obstacle is that stock is lower than needed, so it can still contribute to a split.
      onlyShort:
        quantity !== null && line.issues.length === 1 && line.availableAmount !== null && line.availableAmount > 0 && line.availableAmount < quantity,
      substituteFor: substituteFor.get(product.id) ?? null,
      reasons,
    };
  });
}

/** Fulfillable first, then cheapest for the whole requested amount. */
const rank = (list: Unranked[]): Candidate[] =>
  [...list]
    .sort((a, b) => Number(b.fulfillable) - Number(a.fulfillable) || (a.total ?? Infinity) - (b.total ?? Infinity))
    .map((c, i) => ({ ...c, rank: i + 1 }));

/**
 * Valio's own substitute list for the shortlisted products, narrowed by rules code can check: every required
 * claim present, no blocked allergen contained or possibly contained. At most SHORTLIST_SIZE are priced.
 */
async function findSubstitutes(
  shortlist: ProductSearchResult[],
  request: PurchaseRequest,
  mandate: Mandate
): Promise<{ products: Product[]; replaces: Map<string, string> }> {
  const skip = new Set(shortlist.map((p) => p.id));
  const replaces = new Map<string, string>();
  for (const original of shortlist) {
    for (const id of original.substitutes) if (!skip.has(id) && !replaces.has(id)) replaces.set(id, original.id);
  }
  const found = await getProductsByIds([...replaces.keys()]);
  const products = [...found.values()]
    .filter((p) => request.requiredClaims.every((c) => p.claims.includes(c)))
    .filter((p) => !mandate.blockedAllergens.some((a) => p.allergensContain.includes(a) || p.allergensMayContain.includes(a)))
    .slice(0, SHORTLIST_SIZE);
  return { products, replaces };
}

function explain(candidates: Candidate[], offers: Offer[], request: PurchaseRequest) {
  const unit = request.amountUnit === 'unit' ? '' : ` ${request.amountUnit}`;
  const cheapest = offers.find((o) => o.kinds.includes('cheapest'));
  for (const offer of offers) {
    for (const line of offer.lines) {
      const c = candidates.find((x) => x.productId === line.productId)!;
      const why: string[] = [];
      if (offer.kinds.includes('cheapest')) {
        why.push(
          `Cheapest option that can deliver the full ${request.amount}${unit} on ${request.deliveryDate}` +
            (c.amountPerUnit !== 1 ? ` (${c.quantity} ${c.salesUnit} × ${c.amountPerUnit}${unit}).` : '.')
        );
      }
      if (offer.kinds.includes('most_reliable')) {
        why.push(`Most reliable: delivered in full ${Math.round((c.deliveryReliability ?? 0) * 100)}% of the time.`);
      }
      if (offer.kinds.includes('lowest_co2')) why.push(`Lowest CO2: ${c.co2PerKg} kg CO2-eq per kg (product-group average).`);
      if (offer.kinds.includes('split')) why.push(`Part of a split order: ${line.quantity} ${line.salesUnit} from this product.`);
      if (offer.kinds.includes('substitute')) why.push(`Valio lists this as a substitute for ${line.substituteFor}.`);
      c.reasons.unshift(...why);
    }
  }
  if (cheapest) {
    const cheapestTotal = cheapest.total;
    for (const c of candidates) {
      const inOffer = offers.some((o) => o.lines.some((l) => l.productId === c.productId));
      if (!inOffer && c.fulfillable && c.total !== null && c.substituteFor === null) {
        c.reasons.push(`€${(c.total - cheapestTotal).toFixed(2)} more than the cheapest option.`);
      }
    }
  }
}

/**
 * Checks the products the offers would order against the live web, so a source that contradicts the catalog or a
 * recall notice changes the policy decision without anyone pressing a button. Only runs when the request has claims
 * or the mandate blocks allergens. A check that fails or runs out of time is reported in the result, never fatal.
 */
async function liveCheckOffers(
  offers: Offer[],
  interpreted: PurchaseRequest,
  mandate: Mandate
): Promise<{ liveChecks: LiveChecks | null; notes: string[] }> {
  if (interpreted.requiredClaims.length === 0 && mandate.blockedAllergens.length === 0) return { liveChecks: null, notes: [] };
  const ids = [...new Set(offers.flatMap((o) => o.lines.map((l) => l.productId)))].slice(0, LIVE_CHECK_PRODUCTS);
  if (ids.length === 0) return { liveChecks: null, notes: [] };
  const products = await getProductsByIds(ids);
  return runLiveChecks(
    ids.flatMap((id) => products.get(id) ?? []),
    { verify: (id) => verifyProduct(id), recalls: (p) => checkRecalls(p) },
    { budgetMs: LIVE_CHECK_BUDGET_MS, concurrency: LIVE_CHECK_CONCURRENCY }
  );
}

/**
 * Plain-language need -> structured need -> shortlist -> live price and availability for the shortlist
 * only -> offers (cheapest, most reliable, lowest CO2; a split or Valio's substitutes when nothing can deliver
 * alone) -> a held quote for the default offer.
 */
export async function planRequest(mandateId: string, text: string): Promise<RequestResult> {
  const mandate = await getMandate(mandateId);
  const { request: interpreted, model: interpretModel, check } = await interpretRequest(text);

  const { products: found, semantic, excludedByAllergens } = await searchProducts(
    interpreted.product,
    { claims: interpreted.requiredClaims, excludeAllergens: mandate.blockedAllergens },
    RETRIEVE
  );
  const picked = found.length ? await pickMatches(interpreted, found) : { matches: [], model: interpretModel };
  const shortlist = picked.matches;
  if (shortlist.length === 0) {
    throw new HttpError(
      404,
      `No products match "${interpreted.product}" with ${interpreted.requiredClaims.join(', ') || 'no claims'}` +
        `${mandate.blockedAllergens.length ? ` and without ${mandate.blockedAllergens.join(', ')}` : ''}. ` +
        `Search found ${found.length}${found.length ? ` (${found.map((p) => p.id).join(', ')})` : ''}; ${picked.model} kept 0.`
    );
  }

  let candidates = rank(await priceCandidates(shortlist, interpreted));
  let built = buildOffers(candidates, interpreted);

  // Nothing can deliver, even split: look at the substitutes Valio itself lists.
  if (built.offers.length === 0) {
    const subs = await findSubstitutes(shortlist, interpreted, mandate);
    if (subs.products.length > 0) {
      const subCandidates = await priceCandidates(subs.products, interpreted, subs.replaces);
      candidates = rank([...candidates, ...subCandidates]);
      built = buildOffers(candidates, interpreted);
    }
  }
  const offers = applyPreference(built.offers, mandate.preferredOffer);
  explain(candidates, offers, interpreted);

  // Before the quote and the policy preview, so the preview reads these fresh checks.
  const live = await liveCheckOffers(offers, interpreted, mandate);
  const notes = [...built.notes, ...live.notes];
  if (check.status === 'disagree') {
    notes.unshift(`Check before ordering: two models read the request differently (${check.differences.join('; ')}). ${check.detail}`);
  }

  const best = offers[0] ?? null;
  await logAudit({
    actor: 'agent',
    action: 'request_interpreted',
    mandateId: mandate.id,
    quoteId: null,
    orderId: null,
    summary:
      `${interpretModel} read "${text}" as ${interpreted.amount} ${interpreted.amountUnit} of ${interpreted.product}` +
      `${interpreted.requiredClaims.length ? ` (${interpreted.requiredClaims.join(', ')})` : ''} by ${interpreted.deliveryDate}. ` +
      `Second opinion by ${check.secondModel}: ${check.status === 'agree' ? `agrees (${check.detail})` : check.status === 'disagree' ? `DISAGREES, ${check.differences.join('; ')}` : `unavailable (${check.detail})`}. ` +
      `${excludedByAllergens ? `The mandate hid ${excludedByAllergens} matching products with blocked allergens. ` : ''}` +
      `Searched ${found.length} catalog products${semantic ? '' : ' (keyword search only: semantic search unavailable)'}, ${picked.model} kept ${shortlist.length} that match, priced those only. ` +
      (best
        ? `${offers.length} offer(s); default is "${best.label}" at €${best.total.toFixed(2)}${best.kinds.includes(mandate.preferredOffer) ? ` (the mandate prefers ${mandate.preferredOffer.replace('_', ' ')})` : ''}. ${notes.join(' ')}`
        : notes.join(' ')),
    data: { interpreted, interpretationCheck: check, candidateIds: candidates.map((c) => c.productId), offers: offers.map((o) => ({ id: o.id, kinds: o.kinds, total: o.total })) },
  });

  const quote = best
    ? await createQuote({
        mandateId: mandate.id,
        deliveryDate: interpreted.deliveryDate,
        lines: best.lines.map((l) => ({ productId: l.productId, quantity: l.quantity, substituteFor: l.substituteFor })),
      })
    : null;

  return {
    text,
    models: { interpreted: interpretModel, picked: picked.model },
    excludedByMandate: excludedByAllergens,
    interpreted,
    // The agent sees whether a product can fill the request, never the exact stock.
    // The agent sees whether a product can fill the request, never the exact stock: not as a number, and not inside a reason.
    candidates: candidates.map((c) => ({ ...c, availableAmount: null, reasons: c.reasons.map(sanitizeIssue) })),
    offers,
    quote: quote ? exposeQuote(quote) : null,
    policy: quote ? await previewPolicy(quote) : null,
    notes,
    liveChecks: live.liveChecks,
    interpretationCheck: check,
  };
}
