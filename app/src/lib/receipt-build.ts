import { createHash } from 'node:crypto';
import { exposeOrder, exposeQuote } from './exposure.ts';
import { canonicalJson } from './receipt-canon.ts';
import type { ApproverSignature, Mandate, Order, PolicyOutcome, Quote, ReceiptBundle } from '../types/index.ts';

// Pure. Assembles a receipt from what the server read and signs it. The caller supplies `sign`, so the key stays in
// signing.ts and tests can use a fixed one.

export interface ReceiptParts {
  exportedAt: string;
  order: Order;
  quote: Quote;
  /** The mandate as it is now. */
  mandate: Mandate;
  audit: ReceiptBundle['audit'];
  /** What the approver's device signed, if the client signed it. */
  approverSignature: ApproverSignature | null;
}

/** The mandate fields that decide what an agent may do. */
export function mandateSnapshot(m: Mandate): ReceiptBundle['mandate']['snapshot'] {
  return {
    id: m.id,
    buyerName: m.buyerName,
    agentName: m.agentName,
    autoApproveLimitEur: m.autoApproveLimitEur,
    maxOrderEur: m.maxOrderEur,
    blockedAllergens: m.blockedAllergens,
    minDeliveryReliability: m.minDeliveryReliability,
    requireConfirmedStock: m.requireConfirmedStock,
    maxCo2PerKg: m.maxCo2PerKg,
    preferredOffer: m.preferredOffer,
  };
}

const ORDER_EVENTS = ['order_confirmed', 'order_sent_for_approval', 'order_rejected_by_policy'];

/** What the mandate decided when the order was placed, as the audit event recorded it. */
function policyOutcome(audit: ReceiptBundle['audit']): PolicyOutcome | null {
  for (const e of audit.events) {
    if ('action' in e && ORDER_EVENTS.includes(e.action)) {
      const outcome = e.data.outcome;
      if (outcome === 'auto_approve' || outcome === 'needs_approval' || outcome === 'reject') return outcome;
    }
  }
  return null;
}

export function buildReceipt(parts: ReceiptParts, sign: (text: string) => { keyId: string; value: string }): ReceiptBundle {
  const { order, quote, mandate } = parts;
  const snapshot = mandateSnapshot(mandate);
  const unsigned: Omit<ReceiptBundle, 'signature'> = {
    version: 1,
    exportedAt: parts.exportedAt,
    order: exposeOrder(order),
    quote: exposeQuote(quote),
    mandate: { snapshot, hash: createHash('sha256').update(canonicalJson(snapshot)).digest('hex'), capturedAt: parts.exportedAt },
    policy: { outcome: policyOutcome(parts.audit), reasons: order.policyReasons },
    decision:
      order.decidedBy && order.decidedAt
        ? {
            status: order.status === 'confirmed' ? 'approved' : 'declined',
            decidedBy: order.decidedBy,
            decidedAt: order.decidedAt,
            note: order.decisionNote,
            approverSignature: parts.approverSignature,
          }
        : null,
    audit: parts.audit,
  };
  const { keyId, value } = sign(canonicalJson(unsigned));
  return { ...unsigned, signature: { alg: 'EdDSA', keyId, value } };
}
