import 'server-only';
import { logAudit } from '@/lib/audit';
import { getProductsByIds } from '@/lib/catalog';
import { getPool } from '@/lib/db';
import { HttpError } from '@/lib/http';
import { evaluateOrder } from '@/lib/policy';
import { getAvailability, getPrices } from '@/lib/valio';
import type { Mandate, Order, OrderStatus, Quote, QuoteLine } from '@/types';

/** How long a quoted price is held for the agent. */
const QUOTE_TTL_MS = 15 * 60 * 1000;

/** The mock reports this or more when the real stock is unknown or unlimited. */
const UNKNOWN_STOCK = 999999;

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Valio timestamps end in "+0200", which is not valid ISO 8601 without the colon. */
const parseValioTime = (s: string) => new Date(s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));

// --- Mandates ---------------------------------------------------------------

export async function getMandate(id: string): Promise<Mandate> {
  const { rows } = await getPool().query('SELECT * FROM mandates WHERE id = $1', [id]);
  if (rows.length === 0) throw new HttpError(404, `Unknown mandate: ${id}`);
  const r = rows[0];
  return {
    id: r.id,
    buyerName: r.buyer_name,
    agentName: r.agent_name,
    autoApproveLimitEur: r.auto_approve_limit_eur,
    maxOrderEur: r.max_order_eur,
    blockedAllergens: r.blocked_allergens,
  };
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
});

export interface QuoteRequest {
  mandateId: string;
  /** YYYY-MM-DD */
  deliveryDate: string;
  lines: { productId: string; quantity: number }[];
}

/**
 * Fetches live price and availability from Valio for the requested lines and stores the result
 * as a quote whose prices are held until `expiresAt`. An order can only be placed against a quote.
 */
export async function createQuote(request: QuoteRequest): Promise<Quote> {
  const ids = request.lines.map((l) => l.productId);
  if (new Set(ids).size !== ids.length) throw new HttpError(400, 'Each product may appear on only one line.');

  const [mandate, products] = await Promise.all([getMandate(request.mandateId), getProductsByIds(ids)]);

  for (const { productId, quantity } of request.lines) {
    const product = products.get(productId);
    if (!product) throw new HttpError(404, `Unknown product: ${productId}`);
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

  const lines = request.lines.map(({ productId, quantity }): QuoteLine => {
    const product = products.get(productId)!;
    const price = prices.products.find((p) => p.productId === productId);
    const avail = availability.products.find((p) => p.productId === productId);
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
      if (schedule.availableDate && schedule.availableDate > request.deliveryDate) {
        issues.push(`Earliest delivery is ${schedule.availableDate}.`);
      }
      if (availableAmount !== null && availableAmount < quantity) {
        issues.push(`Only ${availableAmount} ${unit} available.`);
      }
    }

    if (avail?.closingTime) {
      const closing = parseValioTime(avail.closingTime).getTime();
      if (closing <= now) issues.push(`Order cut-off passed at ${avail.closingTime}.`);
      else expiresAt = Math.min(expiresAt, closing);
    }

    return {
      productId,
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
    };
  });

  const fulfillable = lines.every((l) => l.fulfillable);
  const total = round2(lines.reduce((sum, l) => sum + (l.lineTotal ?? 0), 0));
  const totalWithTax = round2(lines.reduce((sum, l) => sum + (l.lineTotalWithTax ?? 0), 0));

  const { rows } = await getPool().query<QuoteRow>(
    `INSERT INTO quotes (mandate_id, delivery_date, currency, lines, total, total_with_tax, fulfillable, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [mandate.id, request.deliveryDate, prices.currency, JSON.stringify(lines), total, totalWithTax, fulfillable, new Date(expiresAt)]
  );
  const quote = toQuote(rows[0]);

  const problems = lines.filter((l) => !l.fulfillable).map((l) => `${l.name}: ${l.issues.join(' ')}`);
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
    const problems = quote.lines.filter((l) => !l.fulfillable).map((l) => `${l.name}: ${l.issues.join(' ')}`);
    throw new HttpError(409, `Quote cannot be ordered as is. ${problems.join(' ')}`);
  }

  const [mandate, products] = await Promise.all([
    getMandate(quote.mandateId),
    getProductsByIds(quote.lines.map((l) => l.productId)),
  ]);
  const decision = evaluateOrder(mandate, quote, products);
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

  return order;
}

/** A human approves or declines an order that is waiting for sign-off. */
export async function decideOrder(
  orderId: string,
  decision: 'approve' | 'decline',
  decidedBy: string,
  note?: string
): Promise<Order> {
  const { rows } = await getPool().query<OrderRow>(
    `UPDATE orders SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4
     WHERE id = $1 AND status = 'pending_approval' RETURNING *`,
    [orderId, decision === 'approve' ? 'confirmed' : 'rejected', decidedBy, note ?? null]
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
    data: { decidedBy, note: note ?? null },
  });

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
