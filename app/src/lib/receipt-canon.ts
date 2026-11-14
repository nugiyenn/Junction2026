import type { Quote, QuoteLine } from '../types/index.ts';

// Pure and free of node: imports, so the same text is built on the server, in the browser verifier and in tests.
// What is signed or hashed is always one of the strings made here; only the hashing and signing differ per runtime.

/** JSON with object keys sorted, so the same content always gives the same text. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** The exact text that is signed: the commercial terms of the offer, canonically serialised. */
export function offerPayload(
  quote: Pick<Quote, 'id' | 'mandateId' | 'deliveryDate' | 'currency' | 'total' | 'totalWithTax' | 'createdAt' | 'expiresAt'> & {
    lines: Pick<QuoteLine, 'productId' | 'quantity' | 'salesUnit' | 'unitPrice' | 'lineTotal' | 'substituteFor'>[];
  }
): string {
  return canonicalJson({
    v: 1,
    quoteId: quote.id,
    mandateId: quote.mandateId,
    deliveryDate: quote.deliveryDate,
    currency: quote.currency,
    lines: quote.lines.map((l) => ({
      productId: l.productId,
      quantity: l.quantity,
      salesUnit: l.salesUnit,
      unitPrice: l.unitPrice,
      lineTotal: l.lineTotal,
      substituteFor: l.substituteFor ?? null,
    })),
    total: quote.total,
    totalWithTax: quote.totalWithTax,
    createdAt: quote.createdAt,
    expiresAt: quote.expiresAt,
  });
}

/** The fields of an audit event that its hash covers. */
export interface HashedEvent {
  at: string;
  actor: string;
  action: string;
  mandateId: string | null;
  quoteId: string | null;
  orderId: string | null;
  summary: string;
  data: unknown;
}

/** The text an audit event's SHA-256 is taken over: the previous hash (or GENESIS), a bar, the canonical content. */
export function eventHashInput(prevHash: string | null, event: HashedEvent): string {
  const body = canonicalJson({
    at: event.at,
    actor: event.actor,
    action: event.action,
    mandateId: event.mandateId,
    quoteId: event.quoteId,
    orderId: event.orderId,
    summary: event.summary,
    data: event.data,
  });
  return `${prevHash ?? 'GENESIS'}|${body}`;
}

/** What a person's device signs when they approve or decline: the fields below, canonically serialised. */
export interface DecisionPayload {
  orderId: string;
  decision: 'approve' | 'decline';
  decidedBy: string;
  note: string | null;
  signedAt: string;
}

export const decisionText = (p: DecisionPayload): string =>
  canonicalJson({ orderId: p.orderId, decision: p.decision, decidedBy: p.decidedBy, note: p.note, signedAt: p.signedAt });
