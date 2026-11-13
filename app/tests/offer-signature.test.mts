import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateSigningKey, offerPayload, signPayload, toJwk, verifyPayload } from '../src/lib/offer-signature.ts';
import type { Quote, QuoteLine } from '../src/types/index.ts';

const line = (over: Partial<QuoteLine> = {}): QuoteLine =>
  ({ productId: 'p1', quantity: 1000, salesUnit: 'ST', unitPrice: 1.4, lineTotal: 1400, availableAmount: 777, internal: { listPrice: 2 }, ...over }) as QuoteLine;

const quote = (over: Partial<Quote> = {}): Quote =>
  ({
    id: 'q1',
    mandateId: 'demo-hotel',
    deliveryDate: '2026-11-16',
    currency: 'EUR',
    lines: [line()],
    total: 1400,
    totalWithTax: 1590,
    createdAt: '2026-11-13T20:00:00.000Z',
    expiresAt: '2026-11-13T20:15:00.000Z',
    ...over,
  }) as Quote;

describe('signed offers', () => {
  const { privatePem, publicPem } = generateSigningKey();
  const signed = signPayload(offerPayload(quote()), privatePem);

  it('verifies with the public key, as a PEM or as the published JWK', () => {
    assert.ok(verifyPayload(offerPayload(quote()), signed, publicPem));
    assert.ok(verifyPayload(offerPayload(quote()), signed, toJwk(publicPem, 'k1')));
  });

  it('publishes an Ed25519 JWK with a key id and no private part', () => {
    const jwk = toJwk(publicPem, 'k1');
    assert.equal(jwk.kty, 'OKP');
    assert.equal(jwk.crv, 'Ed25519');
    assert.equal(jwk.kid, 'k1');
    assert.equal('d' in jwk, false);
  });

  it('fails when the price is changed', () => {
    assert.equal(verifyPayload(offerPayload(quote({ lines: [line({ unitPrice: 1.0, lineTotal: 1000 })], total: 1000 })), signed, publicPem), false);
  });
  it('fails when the quantity, total, delivery date or validity is changed', () => {
    for (const changed of [
      quote({ lines: [line({ quantity: 2000 })] }),
      quote({ total: 1 }),
      quote({ totalWithTax: 1 }),
      quote({ deliveryDate: '2026-11-17' }),
      quote({ expiresAt: '2030-01-01T00:00:00.000Z' }),
      quote({ mandateId: 'demo-school' }),
    ]) {
      assert.equal(verifyPayload(offerPayload(changed), signed, publicPem), false);
    }
  });
  it('fails with another key, a damaged signature, or an empty one', () => {
    assert.equal(verifyPayload(offerPayload(quote()), signed, generateSigningKey().publicPem), false);
    assert.equal(verifyPayload(offerPayload(quote()), signed.slice(0, -4) + 'AAAA', publicPem), false);
    assert.equal(verifyPayload(offerPayload(quote()), '', publicPem), false);
    assert.equal(verifyPayload(offerPayload(quote()), signed, 'not a key'), false);
  });

  it('does not sign what Valio keeps private, so the agent can verify without seeing it', () => {
    const payload = offerPayload(quote());
    assert.equal(payload.includes('777'), false);
    assert.equal(payload.includes('listPrice'), false);
  });
  it('is the same whatever the order of keys or the internal fields', () => {
    assert.equal(offerPayload(quote()), offerPayload(quote({ lines: [line({ availableAmount: 1, internal: undefined })] })));
  });
});
