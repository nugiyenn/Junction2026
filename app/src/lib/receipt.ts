import 'server-only';
import { getPool } from '@/lib/db';
import { HttpError } from '@/lib/http';
import { getMandate, getOrder, getQuote } from '@/lib/purchasing';
import { buildReceipt } from '@/lib/receipt-build';
import { textSigner } from '@/lib/signing';
import type { ApproverSignature, ReceiptAuditEvent, ReceiptAuditStub, ReceiptBundle } from '@/types';

/** Events of other orders that sit between this order's first and last event. Past this many, they are left out. */
const MAX_STUBS = 3000;

interface EventRow {
  id: string;
  at: Date;
  actor: ReceiptAuditEvent['actor'];
  action: ReceiptAuditEvent['action'];
  mandate_id: string | null;
  quote_id: string | null;
  order_id: string | null;
  summary: string;
  data: Record<string, unknown>;
  prev_hash: string | null;
  hash: string | null;
}

const toEvent = (r: EventRow): ReceiptAuditEvent => ({
  id: r.id,
  at: r.at.toISOString(),
  actor: r.actor,
  action: r.action,
  mandateId: r.mandate_id,
  quoteId: r.quote_id,
  orderId: r.order_id,
  summary: r.summary,
  data: r.data,
  prevHash: r.prev_hash,
  hash: r.hash,
});

async function auditSlice(quoteId: string, orderId: string): Promise<ReceiptBundle['audit']> {
  const pool = getPool();
  const [{ rows: own }, { rows: head }] = await Promise.all([
    pool.query<EventRow>('SELECT * FROM audit_events WHERE quote_id = $1 OR order_id = $2 ORDER BY id ASC', [quoteId, orderId]),
    pool.query<{ id: string; hash: string | null }>('SELECT id, hash FROM audit_events ORDER BY id DESC LIMIT 1'),
  ]);
  const events: ReceiptBundle['audit']['events'] = own.map(toEvent);
  let linked = true;
  if (own.length > 1) {
    const { rows: between } = await pool.query<{ id: string; prev_hash: string | null; hash: string | null }>(
      `SELECT id, prev_hash, hash FROM audit_events
       WHERE id > $1 AND id < $2 AND quote_id IS DISTINCT FROM $3 AND order_id IS DISTINCT FROM $4 ORDER BY id ASC LIMIT $5`,
      [own[0].id, own[own.length - 1].id, quoteId, orderId, MAX_STUBS + 1]
    );
    if (between.length > MAX_STUBS) {
      linked = false;
    } else {
      const stubs: ReceiptAuditStub[] = between.map((r) => ({ id: r.id, prevHash: r.prev_hash, hash: r.hash, omitted: true }));
      events.push(...stubs);
      events.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    }
  }
  return { events, linked, head: head[0] ?? null };
}

/** What the approver's device signed for this order, if anything. */
async function approverSignature(orderId: string): Promise<ApproverSignature | null> {
  const { rows } = await getPool().query<{ payload: ApproverSignature['payload'] | null; signature: string | null; public_key: ApproverSignature['publicKey'] | null }>(
    'SELECT decision_payload AS payload, decision_signature AS signature, decision_public_key AS public_key FROM orders WHERE id = $1',
    [orderId]
  );
  const r = rows[0];
  return r?.payload && r.signature && r.public_key ? { alg: 'ES256', payload: r.payload, value: r.signature, publicKey: r.public_key } : null;
}

/** The signed receipt for one order. Written to nothing: it is rebuilt on every request. */
export async function getReceipt(orderId: string): Promise<ReceiptBundle> {
  const order = await getOrder(orderId);
  const [quote, mandate, audit, approval, sign] = await Promise.all([
    getQuote(order.quoteId),
    getMandate(order.mandateId),
    auditSlice(order.quoteId, order.id),
    approverSignature(order.id),
    textSigner(),
  ]);
  if (audit.events.length === 0) throw new HttpError(404, 'This order has no decision record to build a receipt from.');
  return buildReceipt({ exportedAt: new Date().toISOString(), order, quote, mandate, audit, approverSignature: approval }, sign);
}
