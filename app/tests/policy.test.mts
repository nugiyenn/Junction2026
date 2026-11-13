import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateOrder } from '../src/lib/policy.ts';
import type { Mandate, Product, Quote, QuoteLine, Verification } from '../src/types/index.ts';

const mandate = (over: Partial<Mandate> = {}): Mandate => ({
  id: 'm',
  buyerName: 'Buyer',
  agentName: 'Agent',
  autoApproveLimitEur: 500,
  maxOrderEur: 5000,
  blockedAllergens: [],
  minDeliveryReliability: null,
  requireConfirmedStock: false,
  maxCo2PerKg: null,
  preferredOffer: 'cheapest',
  ...over,
});

const product = (over: Partial<Product> = {}): Product =>
  ({
    id: 'p1',
    allergensContain: ['AM'],
    allergensMayContain: [],
    allergensFreeFrom: [],
    deliveryReliability: 1,
    ...over,
  }) as Product;

const line = (over: Partial<QuoteLine> = {}): QuoteLine =>
  ({ productId: 'p1', name: 'Test product', logisticModel: 'Stock', ...over }) as QuoteLine;

const run = (m: Mandate, total: number, p: Product, l: QuoteLine) =>
  evaluateOrder(m, { total, lines: [l] } as Quote, new Map([[p.id, p]]));

describe('spend limits', () => {
  it('auto-approves within the limit with nothing to note', () => {
    assert.deepEqual(run(mandate(), 100, product(), line()), { outcome: 'auto_approve', reasons: [] });
  });
  it('needs a human above the auto-approve limit', () => {
    assert.equal(run(mandate(), 1400, product(), line()).outcome, 'needs_approval');
  });
  it('rejects above the maximum', () => {
    assert.equal(run(mandate(), 6000, product(), line()).outcome, 'reject');
  });
});

describe('allergens', () => {
  const school = mandate({ blockedAllergens: ['AN'] });
  it('rejects a product that contains a blocked allergen', () => {
    assert.equal(run(school, 100, product({ allergensContain: ['AN'] }), line()).outcome, 'reject');
  });
  it('needs a human for may-contain', () => {
    assert.equal(run(school, 100, product({ allergensMayContain: ['AN'] }), line()).outcome, 'needs_approval');
  });
  it('treats a product with no allergen data as unverified when allergens are blocked', () => {
    const none = product({ allergensContain: [], allergensMayContain: [], allergensFreeFrom: [] });
    const d = run(school, 100, none, line());
    assert.equal(d.outcome, 'needs_approval');
    assert.match(d.reasons[0], /no allergen data/);
  });
  it('does not flag missing allergen data when the mandate blocks nothing', () => {
    const none = product({ allergensContain: [], allergensMayContain: [], allergensFreeFrom: [] });
    assert.equal(run(mandate(), 100, none, line()).outcome, 'auto_approve');
  });
  it('accepts a product that states what it is free from', () => {
    const free = product({ allergensContain: [], allergensFreeFrom: ['AN', 'AP'] });
    assert.equal(run(school, 100, free, line()).outcome, 'auto_approve');
  });
});

describe('carbon footprint', () => {
  const green = mandate({ maxCo2PerKg: 5 });
  it('needs a human above the maximum', () => {
    const d = run(green, 100, product({ co2PerKg: 7.5 }), line());
    assert.equal(d.outcome, 'needs_approval');
    assert.match(d.reasons[0], /7\.5 kg CO2-eq per kg/);
  });
  it('passes at the maximum, below it, and when the footprint is unknown', () => {
    assert.equal(run(green, 100, product({ co2PerKg: 5 }), line()).outcome, 'auto_approve');
    assert.equal(run(green, 100, product({ co2PerKg: 1.2 }), line()).outcome, 'auto_approve');
    assert.equal(run(green, 100, product({ co2PerKg: null }), line()).outcome, 'auto_approve');
  });
  it('has no rule when the mandate sets none', () => {
    assert.equal(run(mandate(), 100, product({ co2PerKg: 30 }), line()).outcome, 'auto_approve');
  });
});

describe('delivery reliability', () => {
  const strict = mandate({ minDeliveryReliability: 0.9 });
  it('needs a human below the minimum', () => {
    const d = run(strict, 100, product({ deliveryReliability: 0.7 }), line());
    assert.equal(d.outcome, 'needs_approval');
    assert.match(d.reasons[0], /70%/);
  });
  it('passes at or above the minimum, and when reliability is unknown', () => {
    assert.equal(run(strict, 100, product({ deliveryReliability: 0.9 }), line()).outcome, 'auto_approve');
    assert.equal(run(strict, 100, product({ deliveryReliability: null }), line()).outcome, 'auto_approve');
  });
  it('is off when the mandate sets no minimum', () => {
    assert.equal(run(mandate(), 100, product({ deliveryReliability: 0.1 }), line()).outcome, 'auto_approve');
  });
});

describe('stock confirmation and substitutes', () => {
  it('needs a human for Terminal stock only when the mandate requires confirmed stock', () => {
    const terminal = line({ logisticModel: 'Terminal' });
    assert.equal(run(mandate({ requireConfirmedStock: true }), 100, product(), terminal).outcome, 'needs_approval');
    assert.equal(run(mandate(), 100, product(), terminal).outcome, 'auto_approve');
    assert.equal(run(mandate({ requireConfirmedStock: true }), 100, product(), line()).outcome, 'auto_approve');
  });
  it('needs a human for a substitute line', () => {
    const d = run(mandate(), 100, product(), line({ isSubstitute: true }));
    assert.equal(d.outcome, 'needs_approval');
    assert.match(d.reasons[0], /substitute/);
  });
});

describe('live web checks', () => {
  const school = mandate({ blockedAllergens: ['AN'] });
  const none = product({ allergensContain: [], allergensMayContain: [], allergensFreeFrom: [] });
  const stmt = (allergen: string, stance: 'contains' | 'may_contain' | 'free_from') => ({
    topic: 'allergen' as const,
    stance,
    allergen,
    text: '',
    evidence: '',
    sourceUrl: 'https://shop.example/p',
  });
  const check = (over: Partial<Verification> = {}): Verification => ({
    productId: 'p1',
    checkedAt: '',
    status: 'confirmed',
    statements: [],
    contradictions: [],
    sources: [],
    searchRequestId: null,
    summary: '',
    ...over,
  });
  const run2 = (p: Product, v: Verification | null) =>
    evaluateOrder(school, { total: 100, lines: [line()] } as Quote, new Map([[p.id, p]]), v ? new Map([['p1', v]]) : new Map());

  it('a source confirming "free from" the blocked allergen clears the unverified rule', () => {
    assert.equal(run2(none, null).outcome, 'needs_approval');
    assert.equal(run2(none, check({ statements: [stmt('AN', 'free_from')] })).outcome, 'auto_approve');
  });
  it('a source that says nothing about the blocked allergen does not clear it', () => {
    assert.equal(run2(none, check({ statements: [stmt('AM', 'contains')] })).outcome, 'needs_approval');
  });
  it('a source saying "contains" a blocked allergen rejects, even when the catalog has no data', () => {
    const d = run2(none, check({ status: 'contradiction', statements: [stmt('AN', 'contains')], contradictions: ['x'] }));
    assert.equal(d.outcome, 'reject');
    assert.match(d.reasons.join(' '), /shop\.example/);
  });
  it('a source saying "may contain" needs a human', () => {
    assert.equal(run2(product({ allergensFreeFrom: ['AN'] }), check({ statements: [stmt('AN', 'may_contain')] })).outcome, 'needs_approval');
  });
  it('a disagreement with the catalog needs a human even for an allergen the mandate does not block', () => {
    const d = run2(product(), check({ status: 'contradiction', contradictions: ['Source says it contains soy; the catalog is free from soy.'] }));
    assert.equal(d.outcome, 'needs_approval');
    assert.match(d.reasons[0], /disagrees with the catalog/);
  });
});

describe('combining rules', () => {
  it('lists every reason and the strictest outcome wins', () => {
    const d = run(
      mandate({ blockedAllergens: ['AN'], minDeliveryReliability: 0.9 }),
      1400,
      product({ allergensContain: ['AN'], deliveryReliability: 0.5 }),
      line()
    );
    assert.equal(d.outcome, 'reject');
    assert.equal(d.reasons.length, 3);
  });
  it('rejects a product that is no longer in the catalog', () => {
    const d = evaluateOrder(mandate(), { total: 1, lines: [line({ productId: 'gone' })] } as Quote, new Map());
    assert.equal(d.outcome, 'reject');
  });
});
