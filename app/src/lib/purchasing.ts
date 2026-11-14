import 'server-only';
import { logAudit } from '@/lib/audit';
import { getProductsByIds } from '@/lib/catalog';
import { detectDeviations } from '@/lib/deviation';
import { getDeviationReport, loadDeviationHistory } from '@/lib/deviation-history';
import { describeProblems } from '@/lib/exposure';
import { getPool } from '@/lib/db';
import { HttpError } from '@/lib/http';
import { evaluateOrder } from '@/lib/policy';
import { getRecallChecks } from '@/lib/recall';
import { signQuote, verifyQuoteSignature } from '@/lib/signing';
import { getVerifications } from '@/lib/verify';
import { getAvailability, getPrices } from '@/lib/valio';
import type {
  ApproverSignature,
  DeviationReport,
  Mandate,
  OfferPreference,
  Order,
  PolicyDecision,
  OrderStatus,
  Product,
  Quote,
  QuoteLine,
  ValioProductAvailability,
  ValioProductPrice,
} from '@/types';

/** How long a quoted price is held for the agent. */
const QUOTE_TTL_MS = 15 * 60 * 1000;

/** The mock reports this or more when the real stock is unknown or unlimited. */
const UNKNOWN_STOCK = 999999;

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Valio timestamps end in "+0200", which is not valid ISO 8601 without the colon. */
const parseValioTime = (s: string) => new Date(s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));

// --- Mandates ---------------------------------------------------------------

interface MandateRow {
  id: string;
  buyer_name: string;
  agent_name: string;
  auto_approve_limit_eur: number;
  max_order_eur: number;
  blocked_allergens: string[];
  min_delivery_reliability: number | null;
  require_confirmed_stock: boolean;
  max_co2_per_kg: number | null;
  preferred_offer: OfferPreference;
}

const toMandate = (r: MandateRow): Mandate => ({
  id: r.id,
  buyerName: r.buyer_name,
  agentName: r.agent_name,
  autoApproveLimitEur: r.auto_approve_limit_eur,
  maxOrderEur: r.max_order_eur,
  blockedAllergens: r.blocked_allergens,
  minDeliveryReliability: r.min_delivery_reliability,
  requireConfirmedStock: r.require_confirmed_stock,
  maxCo2PerKg: r.max_co2_per_kg,
  preferredOffer: r.preferred_offer,
});

export async function getMandate(id: string): Promise<Mandate> {
  const { rows } = await getPool().query<MandateRow>('SELECT * FROM mandates WHERE id = $1', [id]);
  if (rows.length === 0) throw new HttpError(404, `Unknown mandate: ${id}`);
  return toMandate(rows[0]);
}

export async function listMandates(): Promise<Mandate[]> {
  const { rows } = await getPool().query<MandateRow>(`SELECT * FROM mandates ORDER BY id`);
  return rows.map(toMandate);
}

export type MandateChanges = Partial<
  Pick<Mandate, 'autoApproveLimitEur' | 'maxOrderEur' | 'blockedAllergens' | 'minDeliveryReliability' | 'requireConfirmedStock' | 'maxCo2PerKg' | 'preferredOffer'>
>;

/** The buyer edits what the agent may do. Takes effect on the next order; held quotes are re-judged at order time. */
export async function updateMandate(id: string, changes: MandateChanges, changedBy: string): Promise<Mandate> {
  const before = await getMandate(id);
  const next = { ...before, ...changes };
  if (next.maxOrderEur < next.autoApproveLimitEur) {
    throw new HttpError(400, 'The maximum order value cannot be below the auto-approve limit.');
  }

  const { rows } = await getPool().query<MandateRow>(
    `UPDATE mandates SET auto_approve_limit_eur = $2, max_order_eur = $3, blocked_allergens = $4,
       min_delivery_reliability = $5, require_confirmed_stock = $6, max_co2_per_kg = $7, preferred_offer = $8
     WHERE id = $1 RETURNING *`,
    [
      id,
      next.autoApproveLimitEur,
      next.maxOrderEur,
      JSON.stringify(next.blockedAllergens),
      next.minDeliveryReliability,
      next.requireConfirmedStock,
      next.maxCo2PerKg,
      next.preferredOffer,
    ]
  );
  const mandate = toMandate(rows[0]);

  const changed = (Object.keys(changes) as (keyof MandateChanges)[]).filter(
    (k) => JSON.stringify(before[k]) !== JSON.stringify(mandate[k])
  );
  if (changed.length > 0) {
    await logAudit({
      actor: 'human',
      action: 'mandate_changed',
      mandateId: id,
      quoteId: null,
      orderId: null,
      summary:
        `${changedBy} changed ${mandate.buyerName}'s mandate: ` +
        changed.map((k) => `${k} ${JSON.stringify(before[k])} → ${JSON.stringify(mandate[k])}`).join(', ') +
        '.',
      data: { changedBy, before: Object.fromEntries(changed.map((k) => [k, before[k]])), after: Object.fromEntries(changed.map((k) => [k, mandate[k]])) },
    });
  }
  return mandate;
}

// --- Quotes -----------------------------------------------------------------

interface QuoteRow {
  id: string;
  mandate_id: string;
  delivery_date: string;
  currency: string;
  lines: QuoteLine[];
  total: number;
  total_with_tax: number;
  fulfillable: boolean;
  created_at: Date;
  expires_at: Date;
  signature: string | null;
  signature_key_id: string | null;
}

const toQuote = (r: QuoteRow): Quote => ({
  id: r.id,
  mandateId: r.mandate_id,
  deliveryDate: r.delivery_date,
  currency: r.currency,
  lines: r.lines,
  total: r.total,
  totalWithTax: r.total_with_tax,
  fulfillable: r.fulfillable,
  createdAt: r.created_at.toISOString(),
  expiresAt: r.expires_at.toISOString(),
  signature: r.signature && r.signature_key_id ? { alg: 'EdDSA', keyId: r.signature_key_id, value: r.signature } : null,
});

/**
 * Turns Valio's price and availability answers for one product into a quote line, listing every
 * reason it cannot be delivered as requested. Shared by quotes and by candidate ranking.
 */
export function buildQuoteLine(
  product: Product,
  quantity: number,
  deliveryDate: string,
  price: ValioProductPrice | undefined,
  avail: ValioProductAvailability | undefined,
  now: number
): QuoteLine {
  const schedule = avail?.scheduleLines[0];
  const unit = schedule?.salesUnit ?? product.salesUnit;
  const issues: string[] = [];

  const unitPrice = price && !price.error ? (price.catalogPrice?.value ?? null) : null;
  const unitPriceWithTax = price && !price.error ? (price.catalogPrice?.valueWithTax ?? null) : null;
  if (unitPrice === null) issues.push('No price available.');

  const availableAmount = schedule && schedule.availableAmount < UNKNOWN_STOCK ? schedule.availableAmount : null;
  if (!schedule) {
    issues.push('Cannot be delivered on any date.');
  } else {
    if (avail.salesBlock || schedule.salesBlock) issues.push('Currently blocked from sale.');
    if (schedule.availableDate && schedule.availableDate > deliveryDate) {
      issues.push(`Earliest delivery is ${schedule.availableDate}.`);
    }
    if (availableAmount !== null && availableAmount < quantity) {
      issues.push(`Only ${availableAmount} ${unit} available.`);
    }
  }

  if (avail?.closingTime && parseValioTime(avail.closingTime).getTime() <= now) {
    issues.push(`Order cut-off passed at ${avail.closingTime}.`);
  }

  return {
    productId: product.id,
    name: product.nameEn ?? product.nameFi,
    quantity,
    salesUnit: unit,
    unitPrice,
    unitPriceWithTax,
    comparisonPrice: price?.comparisonPrice?.value ?? null,
    comparisonUnit: price?.comparisonUnit ?? null,
    lineTotal: unitPrice === null ? null : round2(unitPrice * quantity),
    lineTotalWithTax: unitPriceWithTax === null ? null : round2(unitPriceWithTax * quantity),
    availableAmount,
    availableDate: schedule?.availableDate ?? null,
    closingTime: avail?.closingTime ?? null,
    logisticModel: avail?.logisticModel ?? null,
    fulfillable: issues.length === 0,
    issues,
    substitutes: product.substitutes,
    internal: {
      listPrice: price?.listPrice?.value ?? null,
      discountPct:
        price?.listPrice?.value && unitPrice !== null && price.listPrice.value > 0
          ? round2((1 - unitPrice / price.listPrice.value) * 100)
          : null,
      netPriceFound: price ? price.netPriceFound : null,
      availableAmount,
      vendorName: product.vendorName,
      category: product.category,
    },
  };
}

/** A stored quote, whole (with Valio's internal fields). Pass `latest` for the most recent one. */
export async function getQuote(id: string): Promise<Quote> {
  const { rows } = await getPool().query<QuoteRow>(
    id === 'latest' ? 'SELECT * FROM quotes ORDER BY created_at DESC LIMIT 1' : 'SELECT * FROM quotes WHERE id = $1',
    id === 'latest' ? [] : [id]
  );
  if (rows.length === 0) throw new HttpError(404, id === 'latest' ? 'There are no quotes yet.' : `Unknown quote: ${id}`);
  return toQuote(rows[0]);
}

export interface QuoteRequest {
  mandateId: string;
  /** YYYY-MM-DD */
  deliveryDate: string;
  /**
   * `substituteFor` marks a line as replacing another product. The server accepts it only when Valio itself lists
   * the line's product as a substitute for that one, and the mandate then sends the order to a human.
   */
  lines: { productId: string; quantity: number; substituteFor?: string }[];
}

/**
 * Fetches live price and availability from Valio for the requested lines and stores the result
 * as a quote whose prices are held until `expiresAt`. An order can only be placed against a quote.
 */
export async function createQuote(request: QuoteRequest): Promise<Quote> {
  const ids = request.lines.map((l) => l.productId);
  if (new Set(ids).size !== ids.length) throw new HttpError(400, 'Each product may appear on only one line.');

  const replaced = request.lines.flatMap((l) => (l.substituteFor ? [l.substituteFor] : []));
  const [mandate, products] = await Promise.all([
    getMandate(request.mandateId),
    getProductsByIds([...new Set([...ids, ...replaced])]),
  ]);

  for (const { productId, quantity, substituteFor } of request.lines) {
    const product = products.get(productId);
    if (!product) throw new HttpError(404, `Unknown product: ${productId}`);
    if (substituteFor && !products.get(substituteFor)?.substitutes.includes(productId)) {
      throw new HttpError(400, `${productId} is not a substitute Valio lists for ${substituteFor}.`);
    }
    const lots = quantity / product.allowedLotSize;
    if (Math.abs(lots - Math.round(lots)) > 1e-6) {
      throw new HttpError(400, `Quantity of ${productId} must be a multiple of ${product.allowedLotSize} ${product.salesUnit}.`);
    }
  }

  const [prices, availability] = await Promise.all([
    getPrices(ids, request.deliveryDate),
    getAvailability(ids, request.deliveryDate),
  ]);

  const now = Date.now();
  let expiresAt = now + QUOTE_TTL_MS;

  const lines = request.lines.map(({ productId, quantity, substituteFor }) => {
    const line = buildQuoteLine(
      products.get(productId)!,
      quantity,
      request.deliveryDate,
      prices.products.find((p) => p.productId === productId),
      availability.products.find((p) => p.productId === productId),
      now
    );
    if (line.closingTime && line.fulfillable) {
      expiresAt = Math.min(expiresAt, parseValioTime(line.closingTime).getTime());
    }
    if (substituteFor) {
      line.isSubstitute = true;
      line.substituteFor = substituteFor;
    }
    return line;
  });

  const fulfillable = lines.every((l) => l.fulfillable);
  const total = round2(lines.reduce((sum, l) => sum + (l.lineTotal ?? 0), 0));
  const totalWithTax = round2(lines.reduce((sum, l) => sum + (l.lineTotalWithTax ?? 0), 0));

  const { rows } = await getPool().query<QuoteRow>(
    `INSERT INTO quotes (mandate_id, delivery_date, currency, lines, total, total_with_tax, fulfillable, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [mandate.id, request.deliveryDate, prices.currency, JSON.stringify(lines), total, totalWithTax, fulfillable, new Date(expiresAt)]
  );
  const unsigned = toQuote(rows[0]);
  const signature = await signQuote(unsigned);
  await getPool().query('UPDATE quotes SET signature = $2, signature_key_id = $3 WHERE id = $1', [unsigned.id, signature.value, signature.keyId]);
  const quote: Quote = { ...unsigned, signature };

  const problems = describeProblems(lines);
  await logAudit({
    actor: 'agent',
    action: 'quote_issued',
    mandateId: mandate.id,
    quoteId: quote.id,
    orderId: null,
    summary:
      `${mandate.agentName} asked for ${lines.length} product(s) for delivery on ${quote.deliveryDate}: ` +
      `${total.toFixed(2)} ${quote.currency} ex VAT. ` +
      (fulfillable ? 'Everything can be delivered as requested.' : `Cannot be ordered as is. ${problems.join(' ')}`),
    data: { lines: request.lines },
  });

  return quote;
}

// --- Orders -----------------------------------------------------------------

interface OrderRow {
  id: string;
  quote_id: string;
  mandate_id: string;
  status: OrderStatus;
  policy_reasons: string[];
  delivery_date: string;
  currency: string;
  lines: QuoteLine[];
  total: number;
  total_with_tax: number;
  created_at: Date;
  decided_by: string | null;
  decided_at: Date | null;
  decision_note: string | null;
}

const toOrder = (r: OrderRow): Order => ({
  id: r.id,
  quoteId: r.quote_id,
  mandateId: r.mandate_id,
  status: r.status,
  policyReasons: r.policy_reasons,
  deliveryDate: r.delivery_date,
  currency: r.currency,
  lines: r.lines,
  total: r.total,
  totalWithTax: r.total_with_tax,
  createdAt: r.created_at.toISOString(),
  decidedBy: r.decided_by,
  decidedAt: r.decided_at?.toISOString() ?? null,
  decisionNote: r.decision_note,
});

/** Confirmed and pending orders of a mandate in the last 24 hours (ex VAT), leaving out the order for `excludeQuoteId`. */
export async function spentInLast24h(mandateId: string, excludeQuoteId: string | null = null): Promise<number> {
  const { rows } = await getPool().query<{ spent: number }>(
    `SELECT COALESCE(SUM(total), 0)::float8 AS spent FROM orders
     WHERE mandate_id = $1 AND status IN ('confirmed', 'pending_approval')
       AND created_at > now() - interval '24 hours' AND ($2::uuid IS NULL OR quote_id <> $2::uuid)`,
    [mandateId, excludeQuoteId]
  );
  return rows[0].spent;
}

/** Applies the buyer's mandate to a quote. Reads stored web checks only: no live call while an order is judged. */
async function judgeQuote(quote: Quote): Promise<{ mandate: Mandate; decision: PolicyDecision; deviations: DeviationReport }> {
  const lineIds = quote.lines.map((l) => l.productId);
  const [mandate, products, verifications, recalls, spentLast24hEur, history] = await Promise.all([
    getMandate(quote.mandateId),
    getProductsByIds(lineIds),
    getVerifications(lineIds),
    getRecallChecks(lineIds),
    spentInLast24h(quote.mandateId, quote.id),
    loadDeviationHistory(quote.mandateId),
  ]);
  // The unusual-order check compares with the buyer's own past orders, so it also needs the catalog rows of those products.
  const pastIds = [...new Set(history.flatMap((h) => h.lines.map((l) => l.productId)))].filter((id) => !products.has(id));
  const known = pastIds.length ? new Map([...products, ...(await getProductsByIds(pastIds))]) : products;
  const deviations = detectDeviations(history, quote, known);
  return { mandate, decision: evaluateOrder(mandate, quote, products, verifications, recalls, { spentLast24hEur, deviations }), deviations };
}

/** What the mandate would decide if this quote were ordered now. The same rules as placeOrder; writes nothing. */
export async function previewPolicy(quote: Quote): Promise<PolicyDecision> {
  return (await judgeQuote(quote)).decision;
}

/**
 * Commits to a quote at its held prices. The mandate decides whether the order is confirmed at once,
 * waits for a human, or is rejected; the returned order's `status` and `policyReasons` say which.
 */
export async function placeOrder(quoteId: string): Promise<Order> {
  const pool = getPool();
  const { rows: quoteRows } = await pool.query<QuoteRow>('SELECT * FROM quotes WHERE id = $1', [quoteId]);
  if (quoteRows.length === 0) throw new HttpError(404, `Unknown quote: ${quoteId}`);
  const quote = toQuote(quoteRows[0]);

  if (new Date(quote.expiresAt).getTime() <= Date.now()) {
    throw new HttpError(410, `Quote expired at ${quote.expiresAt}. Request a new quote.`);
  }
  if (!quote.fulfillable) {
    const problems = describeProblems(quote.lines);
    throw new HttpError(409, `Quote cannot be ordered as is. ${problems.join(' ')}`);
  }
  // The order commits to the terms Valio signed. A quote edited after it was issued no longer verifies.
  if (!(await verifyQuoteSignature(quote))) {
    throw new HttpError(409, 'The quote is unsigned, or its price or quantities no longer match Valio\'s signature. Request a new quote.');
  }

  const { mandate, decision, deviations } = await judgeQuote(quote);
  const status: OrderStatus = { auto_approve: 'confirmed', needs_approval: 'pending_approval', reject: 'rejected' }[
    decision.outcome
  ] as OrderStatus;

  let order: Order;
  try {
    const { rows } = await pool.query<OrderRow>(
      `INSERT INTO orders (quote_id, mandate_id, status, policy_reasons, delivery_date, currency, lines, total, total_with_tax)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [quote.id, mandate.id, status, JSON.stringify(decision.reasons), quote.deliveryDate, quote.currency,
        JSON.stringify(quote.lines), quote.total, quote.totalWithTax]
    );
    order = toOrder(rows[0]);
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw new HttpError(409, 'This quote has already been ordered.');
    throw err;
  }

  const amount = `${order.total.toFixed(2)} ${order.currency} ex VAT`;
  const why = decision.reasons.join(' ');
  await logAudit({
    actor: 'system',
    action: { confirmed: 'order_confirmed', pending_approval: 'order_sent_for_approval', rejected: 'order_rejected_by_policy' }[
      status
    ] as 'order_confirmed' | 'order_sent_for_approval' | 'order_rejected_by_policy',
    mandateId: mandate.id,
    quoteId: quote.id,
    orderId: order.id,
    summary: {
      confirmed: `Order for ${amount} confirmed automatically: within ${mandate.agentName}'s mandate.`,
      pending_approval: `Order for ${amount} sent to a human at ${mandate.buyerName} for approval. ${why}`,
      rejected: `Order for ${amount} rejected by the mandate. ${why}`,
    }[status],
    data: { outcome: decision.outcome, reasons: decision.reasons },
  });

  // The full unusual-order report is for the approver only. It is stored as an event without a quote or order column,
  // so /api/audit and receipts (which read by those columns) never serve it, and it is not published to Kafka with a body.
  await logAudit({
    actor: 'system',
    action: 'deviation_report',
    mandateId: mandate.id,
    quoteId: null,
    orderId: null,
    summary: 'Compared the order with the buyer\'s usual orders.',
    data: { orderId: order.id, quoteId: quote.id, report: deviations },
  });

  return order;
}

/**
 * A human approves or declines an order that is waiting for sign-off. `approval` is the device signature over the
 * decision, stored beside it so the receipt can show it; the caller has already checked it matches this decision.
 */
export async function decideOrder(
  orderId: string,
  decision: 'approve' | 'decline',
  decidedBy: string,
  note?: string,
  approval?: ApproverSignature,
  /** Approve only: the order was flagged as unusual and the approver says it is the buyer's new normal, so it counts in future baselines. */
  acceptAsNormal = false
): Promise<Order> {
  if (acceptAsNormal) {
    if (decision !== 'approve') throw new HttpError(400, 'Only an approval can be accepted as the new normal.');
    // Checked before anything is written, so a refused request leaves the order waiting.
    if (((await getDeviationReport(orderId))?.differing ?? 0) === 0) {
      throw new HttpError(400, 'This order was not flagged as unusual, so there is nothing to accept as the new normal.');
    }
  }
  const { rows } = await getPool().query<OrderRow>(
    `UPDATE orders SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4,
       decision_payload = $5, decision_signature = $6, decision_public_key = $7
     WHERE id = $1 AND status = 'pending_approval' RETURNING *`,
    [
      orderId,
      decision === 'approve' ? 'confirmed' : 'rejected',
      decidedBy,
      note ?? null,
      approval ? JSON.stringify(approval.payload) : null,
      approval?.value ?? null,
      approval ? JSON.stringify(approval.publicKey) : null,
    ]
  );
  if (rows.length === 0) {
    const existing = await getOrder(orderId); // throws 404 when the order does not exist
    throw new HttpError(409, `Order is ${existing.status}, not waiting for approval.`);
  }
  const order = toOrder(rows[0]);

  await logAudit({
    actor: 'human',
    action: decision === 'approve' ? 'order_approved' : 'order_declined',
    mandateId: order.mandateId,
    quoteId: order.quoteId,
    orderId: order.id,
    summary:
      `${decidedBy} ${decision === 'approve' ? 'approved' : 'declined'} the order for ` +
      `${order.total.toFixed(2)} ${order.currency} ex VAT.${note ? ` Note: ${note}` : ''}`,
    data: { decidedBy, note: note ?? null, signed: Boolean(approval) },
  });

  if (acceptAsNormal) {
    await logAudit({
      actor: 'human',
      action: 'order_accepted_as_normal',
      mandateId: order.mandateId,
      quoteId: order.quoteId,
      orderId: order.id,
      summary: `${decidedBy} accepted this order as the new normal: it now counts as one of the buyer's usual orders.`,
      data: { decidedBy },
    });
  }

  return order;
}

export async function getOrder(orderId: string): Promise<Order> {
  const { rows } = await getPool().query<OrderRow>('SELECT * FROM orders WHERE id = $1', [orderId]);
  if (rows.length === 0) throw new HttpError(404, `Unknown order: ${orderId}`);
  return toOrder(rows[0]);
}

/** Newest first. */
export async function listOrders(status?: OrderStatus): Promise<Order[]> {
  const { rows } = await getPool().query<OrderRow>(
    'SELECT * FROM orders WHERE ($1::text IS NULL OR status = $1) ORDER BY created_at DESC LIMIT 100',
    [status ?? null]
  );
  return rows.map(toOrder);
}
