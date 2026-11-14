import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateSigningKey, offerPayload, signPayload, verifyPayload } from '../src/lib/offer-signature.ts';
import {
  copiedInjectionOutcome,
  FABRICATED_EVIDENCE,
  forgeQuote,
  INJECTED_SENTENCE,
  INJECTION_PAGE,
  INJECTION_PRODUCT,
  isHumanOnlyTool,
  keepsQuote,
  SCENARIO_INFO,
} from '../src/lib/redteam-core.ts';
import { evidenceAppears, pageMatchesProduct } from '../src/lib/evidence.ts';
import type { Quote } from '../src/types/index.ts';

describe('scenario list', () => {
  it('has the eight required attacks plus the copied-quote variant, each fully described', () => {
    const ids = SCENARIO_INFO.map((s) => s.id);
    for (const id of ['structuring', 'replay', 'forged-quote', 'approve-without-key', 'request-injection', 'page-injection', 'stock-probing', 'expired-quote']) {
      assert.ok(ids.includes(id), id);
    }
    assert.equal(new Set(ids).size, ids.length);
    for (const s of SCENARIO_INFO) {
      assert.ok(s.title.length > 0 && s.attempt.length > 0, s.id);
      assert.match(s.mechanism, /src\/lib\/\w[\w-]*\.ts/, `${s.id} names a file`);
    }
  });
});

describe('forged quote', () => {
  const quote = {
    id: 'q1', mandateId: 'demo-redteam', deliveryDate: '2026-11-18', currency: 'EUR', total: 100, totalWithTax: 124,
    createdAt: '2026-11-14T10:00:00.000Z', expiresAt: '2026-11-14T10:15:00.000Z',
    lines: [{ productId: 'p1', quantity: 10, salesUnit: 'ST', unitPrice: 10, lineTotal: 100, lineTotalWithTax: 124 }],
  } as unknown as Quote;

  it('halves the prices and leaves the signature alone', () => {
    const forged = forgeQuote(quote);
    assert.equal(forged.total, 50);
    assert.equal(forged.lines[0].unitPrice, 5);
    assert.equal(quote.total, 100, 'the original is not changed');
  });

  it('the signature of the original does not verify the forged copy', () => {
    const { privatePem, publicPem } = generateSigningKey();
    const signature = signPayload(offerPayload(quote), privatePem);
    assert.equal(verifyPayload(offerPayload(quote), signature, publicPem), true);
    assert.equal(verifyPayload(offerPayload(forgeQuote(quote)), signature, publicPem), false);
  });
});

describe('web page injection', () => {
  it('drops a quote the model invented, keeps one that is on the page', () => {
    assert.equal(keepsQuote(FABRICATED_EVIDENCE, INJECTION_PAGE), false);
    assert.equal(keepsQuote('Ingredients: oats, sugar, vegetable oil.', INJECTION_PAGE), true);
  });

  it('the fixture page is about the product, so the page check alone would not stop it', () => {
    assert.equal(pageMatchesProduct(INJECTION_PAGE, INJECTION_PRODUCT), true);
  });

  it('a quote copied from the injected sentence passes the evidence check and clears the unverified rule (a finding)', () => {
    assert.equal(evidenceAppears(INJECTED_SENTENCE, INJECTION_PAGE), true);
    const { onPage, aboutProduct, decision } = copiedInjectionOutcome();
    assert.ok(onPage && aboutProduct);
    assert.equal(decision.outcome, 'auto_approve');
  });
});

describe('human-only tools', () => {
  it('recognises approve, decline and mandate-editing names', () => {
    for (const n of ['approve_order', 'decline_order', 'update_mandate', 'mandate_edit']) assert.equal(isHumanOnlyTool(n), true, n);
    for (const n of ['place_order', 'get_mandate', 'create_quote']) assert.equal(isHumanOnlyTool(n), false, n);
  });
});
