import { createHash } from 'node:crypto';
import { DEVIATION_REASON } from './deviation.ts';
import { roundPackSize } from './packs.ts';
import { canonicalJson } from './receipt-canon.ts';
import type { ExposedOrder, PolicyOutcome, PublicJwk, ReceiptBundle } from '../types/index.ts';

// Pure: no database, no server imports. Turns an exposed order into the plain data of an "order confirmation" document.
// It is an order confirmation, never an invoice: no invoice number, VAT breakdown, payment terms or bank details exist
// here, and none may be invented. EXPOSURE LAW (exposure.ts): the document holds only what the buyer already sees in a
// quote or an order. The model is built field by field from a whitelist, so a raw row that still carries a list price,
// discount, supplier, internal category or exact stock cannot leak into it.

export const CONFIRMATION_FOOTER = 'Prototype. Synthetic data. This is an order confirmation, not an invoice.';

export type ConfirmationStatus = 'confirmed' | 'pending' | 'declined';

export const STATUS_LABEL: Record<ConfirmationStatus, string> = {
  confirmed: 'Confirmed',
  pending: 'Waiting for approval',
  declined: 'Declined',
};

export interface ConfirmationLine {
  quantity: number;
  /** The sales unit, e.g. "ST" or "KGM". */
  unit: string;
  name: string;
  /** "Pack about 5 L" when the buyer's price and price per litre or kilo give a size; null otherwise. */
  pack: string | null;
  /** True when this line replaces what the buyer asked for. */
  substitute: boolean;
  unitPrice: number | null;
  lineTotal: number | null;
}

export interface ConfirmationModel {
  title: 'Order confirmation';
  status: ConfirmationStatus;
  statusLabel: string;
  buyerName: string;
  agentName: string;
  orderId: string;
  orderShortId: string;
  createdAt: string;
  deliveryDate: string;
  currency: string;
  lines: ConfirmationLine[];
  /** Sum of priced lines, ex VAT. */
  totalExVat: number;
  mandate: {
    /** One sentence: what the mandate decided when the order was placed. */
    decision: string;
    /** Agent-safe reasons only. */
    reasons: string[];
  };
  /** Present when a person decided the order. */
  approval: {
    result: 'approved' | 'declined';
    decidedBy: string;
    decidedAt: string;
    /** First 16 hex characters of the SHA-256 of the approver's device public key; null when the device did not sign. */
    deviceKeyFingerprint: string | null;
  } | null;
  verification: {
    quoteKeyId: string | null;
    /** Hash of the newest audit event of this order (the head of its part of the chain). */
    auditHeadHash: string | null;
    verifyUrl: string;
  };
  footer: string;
}

/** What the model needs beyond the exposed order. All of it is already in a receipt. */
export interface ConfirmationContext {
  buyerName: string;
  agentName: string;
  policyOutcome: PolicyOutcome | null;
  policyReasons: string[];
  quoteKeyId: string | null;
  decision: { result: 'approved' | 'declined'; decidedBy: string; decidedAt: string; approverPublicKey: PublicJwk | null } | null;
  auditHeadHash: string | null;
  /** The origin the verify link points at, e.g. "https://example.vercel.app". */
  origin: string;
}

/** The context from a signed receipt, which is built from exposeOrder and exposeQuote and holds nothing more than a buyer sees. */
export function contextFromReceipt(bundle: ReceiptBundle, origin: string): ConfirmationContext {
  const own = bundle.audit.events.filter((e): e is Exclude<typeof e, { omitted: true }> => !('omitted' in e));
  const decision = bundle.decision;
  return {
    buyerName: bundle.mandate.snapshot.buyerName,
    agentName: bundle.mandate.snapshot.agentName,
    policyOutcome: bundle.policy.outcome,
    policyReasons: bundle.policy.reasons,
    quoteKeyId: bundle.quote.signature?.keyId ?? null,
    decision: decision
      ? {
          result: decision.status,
          decidedBy: decision.decidedBy,
          decidedAt: decision.decidedAt,
          approverPublicKey: decision.approverSignature?.publicKey ?? null,
        }
      : null,
    auditHeadHash: [...own].reverse().find((e) => e.hash)?.hash ?? null,
    origin,
  };
}

/** SHA-256 (hex) of the canonical JSON of the public key's own members. A device key is not an identity: this names a key, not a person. */
export function deviceKeyFingerprint(key: PublicJwk): string {
  const { crv, kty, x, y } = key;
  return createHash('sha256').update(canonicalJson({ crv, kty, x, y })).digest('hex');
}

const toStatus = (s: ExposedOrder['status']): ConfirmationStatus => (s === 'confirmed' ? 'confirmed' : s === 'pending_approval' ? 'pending' : 'declined');

/** Reasons the agent may see. The unusual-order flag is always the one generic sentence, never anything with numbers. */
export function agentSafeReasons(reasons: string[]): string[] {
  const out = reasons.map((r) => (/usual order|differs from/i.test(r) ? DEVIATION_REASON : r));
  return [...new Set(out)];
}

function mandateDecision(outcome: PolicyOutcome | null, status: ConfirmationStatus, ctx: ConfirmationContext): string {
  const o = outcome ?? (status === 'confirmed' && !ctx.decision ? 'auto_approve' : status === 'declined' && !ctx.decision ? 'reject' : 'needs_approval');
  if (o === 'auto_approve') return `Approved automatically: within ${ctx.agentName}'s mandate.`;
  if (o === 'reject') return `Rejected by the mandate: ${ctx.agentName} may not place this order.`;
  return `Needs approval: a person at ${ctx.buyerName} decides.`;
}

/** "Pack about 5 L", worked out the way packs.ts sizes an order: the price of one sales unit over the price per litre or kilo. */
function packText(line: ExposedOrder['lines'][number]): string | null {
  const { unitPrice, comparisonPrice, comparisonUnit } = line;
  if (!unitPrice || !comparisonPrice || comparisonPrice <= 0 || !comparisonUnit) return null;
  const size = roundPackSize(unitPrice / comparisonPrice);
  return Number.isFinite(size) && size > 0 ? `Pack about ${size} ${comparisonUnit}` : null;
}

export function buildConfirmationModel(order: ExposedOrder, context: ConfirmationContext): ConfirmationModel {
  const status = toStatus(order.status);
  const decision = context.decision;
  const lines: ConfirmationLine[] = order.lines.map((l) => ({
    quantity: l.quantity,
    unit: l.salesUnit,
    name: l.name,
    pack: packText(l),
    substitute: l.isSubstitute === true,
    unitPrice: l.unitPrice,
    lineTotal: l.lineTotal,
  }));
  return {
    title: 'Order confirmation',
    status,
    statusLabel: STATUS_LABEL[status],
    buyerName: context.buyerName,
    agentName: context.agentName,
    orderId: order.id,
    orderShortId: order.id.slice(0, 8),
    createdAt: order.createdAt,
    deliveryDate: order.deliveryDate,
    currency: order.currency,
    lines,
    totalExVat: order.total,
    mandate: { decision: mandateDecision(context.policyOutcome, status, context), reasons: agentSafeReasons(context.policyReasons) },
    approval: decision
      ? {
          result: decision.result,
          decidedBy: decision.decidedBy,
          decidedAt: decision.decidedAt,
          deviceKeyFingerprint: decision.approverPublicKey ? deviceKeyFingerprint(decision.approverPublicKey).slice(0, 16) : null,
        }
      : null,
    verification: {
      quoteKeyId: context.quoteKeyId,
      auditHeadHash: context.auditHeadHash,
      verifyUrl: `${context.origin.replace(/\/+$/, '')}/verify?order=${order.id}`,
    },
    footer: CONFIRMATION_FOOTER,
  };
}

// ---------------------------------------------------------------------------
// Text the PDF can draw. The standard Helvetica font is WinAnsi (Windows-1252): anything else would make pdf-lib throw.
// ---------------------------------------------------------------------------

/** The Windows-1252 characters of the 0x80-0x9F block that WinAnsi has (the other code points there are undefined). Curly quotes, dashes, the euro sign and the trademark sign draw fine, so they stay. */
const WIN_1252_EXTRAS = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');

/** Code points of characters outside WinAnsi that have an obvious plain equivalent. */
const LOOKALIKES = new Map<number, string>([
  [0x201b, "'"], [0x2032, "'"], [0x201f, '"'], [0x2033, '"'],
  [0x2010, '-'], [0x2011, '-'], [0x2012, '-'], [0x2212, '-'], [0xfe63, '-'], [0xff0d, '-'], [0x2219, '-'], [0x22c5, '-'],
  [0x142, 'l'], [0x141, 'L'], [0x111, 'd'], [0x110, 'D'], [0x131, 'i'], [0x127, 'h'], [0x126, 'H'], [0x138, 'k'],
]);

const inRanges = (c: number, ranges: number[][]) => ranges.some(([lo, hi]) => c >= lo && c <= hi);

/** C0 and C1 controls (tab, line breaks), no-break and other Unicode spaces, line and paragraph separators. */
const isSpace = (c: number) => inRanges(c, [[0, 0x1f], [0x7f, 0xa0], [0x1680, 0x1680], [0x2000, 0x200a], [0x2028, 0x2029], [0x202f, 0x202f], [0x205f, 0x205f], [0x3000, 0x3000]]);
/** Zero-width characters, the soft hyphen, combining marks and variation selectors: nothing to draw. */
const isInvisible = (c: number) => inRanges(c, [[0x200b, 0x200f], [0x2060, 0x2060], [0xfeff, 0xfeff], [0xad, 0xad], [0x300, 0x36f], [0xfe00, 0xfe0f]]);

const isWinAnsi = (ch: string) => {
  const c = ch.codePointAt(0)!;
  return (c >= 0x20 && c <= 0x7e) || (c >= 0xa1 && c <= 0xff && c !== 0xad) || WIN_1252_EXTRAS.has(ch);
};

/**
 * Makes any string drawable with a WinAnsi font. Spaces and line breaks become one space. Curly quotes, dashes, the euro and
 * trademark signs stay (WinAnsi has them); dashes and quotes it lacks become plain ones; accented letters outside Latin-1 lose
 * the accent; everything else (emoji, Cyrillic, CJK) becomes "?". One "?" per character, so a name never breaks the render.
 */
export function sanitizeWinAnsi(text: string): string {
  let out = '';
  for (const ch of String(text ?? '').normalize('NFC')) {
    const c = ch.codePointAt(0)!;
    if (isSpace(c)) {
      out += ' ';
    } else if (isInvisible(c)) {
      continue;
    } else if (isWinAnsi(ch)) {
      out += ch;
    } else if (LOOKALIKES.has(c)) {
      out += LOOKALIKES.get(c);
    } else {
      // an accented letter outside Latin-1 (like "ő" or "ž" variants): drop the accent when the base letter is drawable
      const stripped = [...ch.normalize('NFKD')].filter((x) => !isInvisible(x.codePointAt(0)!)).join('');
      out += stripped.length > 0 && [...stripped].every(isWinAnsi) ? stripped : '?';
    }
  }
  return out;
}
