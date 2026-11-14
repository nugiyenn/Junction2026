import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { describe, it } from 'node:test';
import { eventHash } from '../src/lib/chain.ts';
import { generateSigningKey, signPayload, toJwk } from '../src/lib/offer-signature.ts';
import { buildReceipt } from '../src/lib/receipt-build.ts';
import { canonicalJson, decisionText, eventHashInput, offerPayload } from '../src/lib/receipt-canon.ts';
import { signDecision, verifyReceipt, type FindKey } from '../src/lib/receipt-verify.ts';
import type { ApproverSignature, Mandate, Order, PublicJwk, Quote, QuoteLine, ReceiptAuditEvent, ReceiptAuditStub, ReceiptBundle } from '../src/types/index.ts';

const valio = generateSigningKey();
const valioJwk = toJwk(valio.publicPem, 'test-key') as PublicJwk;
const other = generateSigningKey();
const otherJwk = toJwk(other.publicPem, 'test-key') as PublicJwk;
const findKey: FindKey = async (kid) => (kid === 'test-key' ? valioJwk : null);

const line: QuoteLine = {
  productId: '6410405060457',
  name: 'Milk',
  quantity: 10,
  salesUnit: 'KI',
  unitPrice: 12.5,
  unitPriceWithTax: 13.75,
  comparisonPrice: 1.2,
  comparisonUnit: 'KG',
  lineTotal: 125,
  lineTotalWithTax: 137.5,
  availableAmount: 51,
  availableDate: '2026-11-16',
  closingTime: null,
  logisticModel: 'Stock',
  fulfillable: true,
  issues: [],
  substitutes: [],
  internal: { listPrice: 20, discountPct: 37.5, netPriceFound: true, availableAmount: 51, vendorName: 'Secret Dairy Oy', category: 'Dairy' },
};

const baseQuote = (): Quote => ({
  id: '11111111-1111-4111-8111-111111111111',
  mandateId: 'demo-hotel',
  deliveryDate: '2026-11-16',
  currency: 'EUR',
  lines: [line],
  total: 125,
  totalWithTax: 137.5,
  fulfillable: true,
  createdAt: '2026-11-14T10:00:00.000Z',
  expiresAt: '2026-11-14T10:15:00.000Z',
  signature: null,
});
const quote = (): Quote => {
  const q = baseQuote();
  return { ...q, signature: { alg: 'EdDSA', keyId: 'test-key', value: signPayload(offerPayload(q), valio.privatePem) } };
};

const order = (over: Partial<Order> = {}): Order => ({
  id: '22222222-2222-4222-8222-222222222222',
  quoteId: baseQuote().id,
  mandateId: 'demo-hotel',
  status: 'confirmed',
  policyReasons: ['Needs a human: order over the auto-approve limit.'],
  deliveryDate: '2026-11-16',
  currency: 'EUR',
  lines: [line],
  total: 125,
  totalWithTax: 137.5,
  createdAt: '2026-11-14T10:01:00.000Z',
  decidedBy: 'Purchasing manager',
  decidedAt: '2026-11-14T10:05:00.000Z',
  decisionNote: 'ok',
  ...over,
});

const mandate: Mandate = {
  id: 'demo-hotel',
  buyerName: 'Hotel',
  agentName: 'Agent',
  autoApproveLimitEur: 100,
  maxOrderEur: 1000,
  blockedAllergens: ['AP'],
  minDeliveryReliability: null,
  requireConfirmedStock: false,
  maxCo2PerKg: null,
  preferredOffer: 'cheapest',
};

/** A chain the way the database writes it: own events with another order's event between them, hashed in order. */
function audit(): ReceiptBundle['audit'] {
  const specs = [
    { actor: 'agent', action: 'quote_issued', quoteId: baseQuote().id, orderId: null, summary: 'Quote', data: { lines: [] } },
    { actor: 'agent', action: 'quote_issued', quoteId: '99999999-9999-4999-8999-999999999999', orderId: null, summary: 'Someone else', data: {} },
    { actor: 'system', action: 'order_sent_for_approval', quoteId: baseQuote().id, orderId: order().id, summary: 'Sent', data: { outcome: 'needs_approval', reasons: [] } },
    { actor: 'human', action: 'order_approved', quoteId: baseQuote().id, orderId: order().id, summary: 'Approved', data: { decidedBy: 'Purchasing manager', note: 'ok', signed: true } },
  ] as const;
  const events: (ReceiptAuditEvent | ReceiptAuditStub)[] = [];
  let prev: string | null = 'f'.repeat(64);
  specs.forEach((s, i) => {
    const e = { at: `2026-11-14T10:0${i}:00.000Z`, mandateId: 'demo-hotel', ...s };
    const hash = eventHash(prev, e);
    events.push(i === 1 ? { id: String(11 + i), prevHash: prev, hash, omitted: true } : { ...e, id: String(11 + i), prevHash: prev, hash });
    prev = hash;
  });
  return { events, linked: true, head: { id: '30', hash: 'a'.repeat(64) } };
}

const device = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
async function approval(over: Partial<ApproverSignature['payload']> = {}): Promise<ApproverSignature> {
  const payload = { orderId: order().id, decision: 'approve' as const, decidedBy: 'Purchasing manager', note: 'ok', signedAt: '2026-11-14T10:05:00.000Z', ...over };
  const { kty, crv, x, y } = (await webcrypto.subtle.exportKey('jwk', device.publicKey)) as PublicJwk;
  return { alg: 'ES256', payload, value: await signDecision(payload, device.privateKey), publicKey: { kty, crv, x, y } };
}

async function bundle(over: { order?: Order; approver?: ApproverSignature | null } = {}): Promise<ReceiptBundle> {
  const approver = over.approver === undefined ? await approval() : over.approver;
  const b = buildReceipt(
    { exportedAt: '2026-11-14T11:00:00.000Z', order: over.order ?? order(), quote: quote(), mandate, audit: audit(), approverSignature: approver },
    (text) => ({ keyId: 'test-key', value: signPayload(text, valio.privatePem) })
  );
  return JSON.parse(JSON.stringify(b)); // what a person downloads
}

const status = (r: Awaited<ReturnType<typeof verifyReceipt>>) => Object.fromEntries(r.checks.map((c) => [c.id, c.status]));
const edit = (b: ReceiptBundle, f: (b: ReceiptBundle) => void) => {
  const copy = JSON.parse(JSON.stringify(b));
  f(copy);
  return copy as ReceiptBundle;
};

describe('receipt round trip', () => {
  it('verifies every part of an untouched receipt', async () => {
    const r = await verifyReceipt(await bundle(), findKey);
    assert.deepEqual(status(r), { bundle: 'pass', quote: 'pass', match: 'pass', mandate: 'pass', audit: 'pass', approver: 'pass' });
    assert.ok(r.ok);
  });

  it('records the policy outcome from the audit event and never carries Valio-internal fields', async () => {
    const b = await bundle();
    assert.equal(b.policy.outcome, 'needs_approval');
    const text = JSON.stringify(b);
    for (const secret of ['listPrice', 'discountPct', 'vendorName', 'Secret Dairy', 'availableAmount', '"internal"']) assert.ok(!text.includes(secret), secret);
  });

  it('marks a decision without a signature, or no decision at all, as not checked rather than failed', async () => {
    const unsigned = await verifyReceipt(await bundle({ approver: null }), findKey);
    assert.equal(status(unsigned).approver, 'skip');
    assert.ok(unsigned.ok);
    const auto = await verifyReceipt(await bundle({ order: order({ decidedBy: null, decidedAt: null, decisionNote: null }), approver: null }), findKey);
    assert.equal(status(auto).approver, 'skip');
  });
});

describe('receipt tampering', () => {
  it('a changed order total fails Valio\'s signature and the match with the quote', async () => {
    const r = await verifyReceipt(edit(await bundle(), (b) => (b.order.total = 99)), findKey);
    assert.equal(status(r).bundle, 'fail');
    assert.equal(status(r).match, 'fail');
    assert.ok(!r.ok);
  });

  it('a changed quote total fails the quote signature', async () => {
    const r = await verifyReceipt(edit(await bundle(), (b) => (b.quote.total = 1)), findKey);
    assert.equal(status(r).quote, 'fail');
    assert.equal(status(r).bundle, 'fail');
  });

  it('a removed audit event breaks the chain links', async () => {
    const r = await verifyReceipt(edit(await bundle(), (b) => b.audit.events.splice(2, 1)), findKey);
    assert.equal(status(r).audit, 'fail');
    assert.match(r.checks.find((c) => c.id === 'audit')!.detail, /removed or reordered/);
    assert.equal(status(r).bundle, 'fail');
  });

  it('an edited audit event fails its own hash', async () => {
    const r = await verifyReceipt(edit(await bundle(), (b) => (b.audit.events[0] as ReceiptAuditEvent).summary = 'Quote for free'), findKey);
    assert.equal(status(r).audit, 'fail');
    assert.match(r.checks.find((c) => c.id === 'audit')!.detail, /changed after/);
  });

  it('an altered decision payload fails the approver signature', async () => {
    const swapped = await verifyReceipt(edit(await bundle(), (b) => (b.decision!.approverSignature!.payload.note = 'rubber stamp')), findKey);
    assert.equal(status(swapped).approver, 'fail');
    // the signed decision must also be the decision recorded
    const signedOther = await bundle({ approver: await approval({ decision: 'decline' }) });
    assert.equal(status(await verifyReceipt(signedOther, findKey)).approver, 'fail');
    // and a signature from a different key does not verify the same payload
    const forged = edit(await bundle(), (b) => (b.decision!.approverSignature!.value = 'A'.repeat(86)));
    assert.equal(status(await verifyReceipt(forged, findKey)).approver, 'fail');
  });

  it('a wrong key fails both Valio signatures, and a receipt re-signed by someone else does not pass', async () => {
    const wrong: FindKey = async () => otherJwk;
    const r = await verifyReceipt(await bundle(), wrong);
    assert.equal(status(r).bundle, 'fail');
    assert.equal(status(r).quote, 'fail');
    const forged = edit(await bundle(), (b) => b.order.total = 99);
    const { signature, ...rest } = forged;
    void signature;
    forged.signature = { alg: 'EdDSA', keyId: 'test-key', value: signPayload(canonicalJson(rest), other.privatePem) };
    assert.equal(status(await verifyReceipt(forged, findKey)).bundle, 'fail');
  });

  it('an unknown key id fails with a message that says what to do', async () => {
    const r = await verifyReceipt(await bundle(), async () => null);
    assert.equal(status(r).bundle, 'fail');
    assert.match(r.checks[0].detail, /No public key/);
  });

  it('a changed mandate fails its hash; a receipt of another version or shape fails instead of throwing', async () => {
    const m = await verifyReceipt(edit(await bundle(), (b) => (b.mandate.snapshot.maxOrderEur = 1e9)), findKey);
    assert.equal(status(m).mandate, 'fail');
    assert.ok(!(await verifyReceipt(edit(await bundle(), (b) => ((b as unknown as { version: number }).version = 2)), findKey)).ok);
    const broken = await verifyReceipt(edit(await bundle(), (b) => delete (b as Partial<ReceiptBundle>).audit), findKey);
    assert.equal(status(broken).audit, 'fail');
    assert.ok(!broken.ok);
  });
});

describe('canonical text', () => {
  it('does not depend on key order, undefined members or a JSON round trip', () => {
    assert.equal(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null }, u: undefined }), canonicalJson({ a: { c: null, d: [1, { y: 2, z: 1 }] }, b: 1 }));
    const value = { total: 12.5, at: '2026-11-14T10:00:00.000Z', n: [0.1, 1e21, -3] };
    assert.equal(canonicalJson(JSON.parse(JSON.stringify(value))), canonicalJson(value));
  });

  it('matches the server\'s hash input and signed offer text exactly', () => {
    const e = { at: '2026-11-14T10:00:00.000Z', actor: 'agent', action: 'quote_issued', mandateId: null, quoteId: null, orderId: null, summary: 's', data: { b: 2, a: 1 } };
    assert.equal(eventHashInput(null, e), 'GENESIS|{"action":"quote_issued","actor":"agent","at":"2026-11-14T10:00:00.000Z","data":{"a":1,"b":2},"mandateId":null,"orderId":null,"quoteId":null,"summary":"s"}');
    assert.equal(
      decisionText({ orderId: 'o', decision: 'approve', decidedBy: 'me', note: null, signedAt: 't' }),
      '{"decidedBy":"me","decision":"approve","note":null,"orderId":"o","signedAt":"t"}'
    );
    assert.match(offerPayload(baseQuote()), /^\{"createdAt":"2026-11-14T10:00:00.000Z","currency":"EUR","deliveryDate":"2026-11-16","expiresAt"/);
  });
});
