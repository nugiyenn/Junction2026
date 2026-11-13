import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyPreference, buildOffers } from '../src/lib/offers.ts';
import type { Candidate, PurchaseRequest } from '../src/types/index.ts';

const request: PurchaseRequest = { product: 'milk', amount: 1000, amountUnit: 'L', deliveryDate: '2026-11-16', requiredClaims: [] };

/** A candidate that can deliver everything unless overridden. 1 L per piece, price per piece = per litre. */
const cand = (id: string, over: Partial<Candidate> = {}): Candidate => ({
  productId: id,
  name: `Product ${id}`,
  quantity: 1000,
  salesUnit: 'ST',
  amountPerUnit: 1,
  unitPrice: 1.5,
  comparisonPrice: 1.5,
  comparisonUnit: 'L',
  total: 1500,
  logisticModel: 'Stock',
  deliveryReliability: 0.95,
  co2PerKg: 1.2,
  labels: [],
  rank: 1,
  fulfillable: true,
  reasons: [],
  availableAmount: 5000,
  allowedLotSize: 1,
  onlyShort: false,
  substituteFor: null,
  ...over,
});

/** A product that is short on stock: not fulfillable, but its stock can be used in a split. */
const short = (id: string, available: number, price: number, over: Partial<Candidate> = {}) =>
  cand(id, {
    fulfillable: false,
    onlyShort: true,
    availableAmount: available,
    unitPrice: price,
    comparisonPrice: price,
    total: price * 1000,
    ...over,
  });

describe('offers when products can deliver everything', () => {
  it('offers the cheapest, most reliable and lowest-CO2 product, merging when one wins several', () => {
    const { offers } = buildOffers(
      [
        cand('cheap', { unitPrice: 1.0, total: 1000, deliveryReliability: 0.8, co2PerKg: 2 }),
        cand('reliable', { unitPrice: 1.4, total: 1400, deliveryReliability: 1, co2PerKg: 2 }),
        cand('green', { unitPrice: 1.3, total: 1300, deliveryReliability: 0.9, co2PerKg: 0.5 }),
      ],
      request
    );
    assert.deepEqual(offers.map((o) => [o.id, o.kinds]), [
      ['cheap', ['cheapest']],
      ['green', ['lowest_co2']],
      ['reliable', ['most_reliable']],
    ]);
    assert.equal(offers[0].total, 1000);
  });

  it('merges kinds when one product wins on several counts', () => {
    const { offers } = buildOffers(
      [cand('best', { total: 1000, unitPrice: 1, deliveryReliability: 1, co2PerKg: 0.5 }), cand('other')],
      request
    );
    assert.equal(offers.length, 1);
    assert.deepEqual(offers[0].kinds, ['cheapest', 'most_reliable', 'lowest_co2']);
    assert.equal(offers[0].label, 'Cheapest · Most reliable · Lowest CO2');
  });

  it('skips reliability and CO2 offers when no product has that data', () => {
    const { offers } = buildOffers([cand('a', { deliveryReliability: null, co2PerKg: null })], request);
    assert.deepEqual(offers[0].kinds, ['cheapest']);
    assert.equal(offers[0].reliability, null);
    assert.equal(offers[0].co2PerKg, null);
  });

  it('ignores products that cannot deliver and substitutes', () => {
    const { offers } = buildOffers(
      [cand('no', { fulfillable: false, total: 1 }), cand('sub', { substituteFor: 'x', total: 2 }), cand('ok', { total: 1500 })],
      request
    );
    assert.deepEqual(offers.map((o) => o.id), ['ok']);
  });
});

describe('split orders', () => {
  it('splits across products from the cheapest stock first when none can cover the request', () => {
    const { offers, notes } = buildOffers([short('a', 600, 1.2), short('b', 700, 1.0), short('c', 900, 2.0)], request);
    assert.equal(offers.length, 1);
    const o = offers[0];
    assert.deepEqual(o.kinds, ['split']);
    assert.equal(o.isSplit, true);
    assert.deepEqual(o.lines.map((l) => [l.productId, l.quantity]), [['b', 700], ['a', 300]]);
    assert.equal(o.total, 700 * 1.0 + 300 * 1.2);
    assert.match(notes[0], /split across 2 products/);
  });

  it('never exceeds a product\'s confirmed stock, and respects pack multiples', () => {
    const { offers } = buildOffers([short('a', 509, 1.0, { allowedLotSize: 10, amountPerUnit: 1 }), short('b', 800, 1.1)], request);
    const a = offers[0].lines.find((l) => l.productId === 'a')!;
    assert.equal(a.quantity, 500); // floor(509 / 10) * 10
    assert.equal(offers[0].lines.find((l) => l.productId === 'b')!.quantity, 500);
  });

  it('does not count Terminal stock, whose quantity is unknown, towards a split', () => {
    const terminal = short('t', 999999, 0.5, { availableAmount: null, logisticModel: 'Terminal' });
    const { offers } = buildOffers([terminal, short('a', 400, 1)], request);
    assert.equal(offers.length, 0);
  });

  it('gives up when even every product together cannot cover the request', () => {
    const { offers, notes } = buildOffers([short('a', 300, 1), short('b', 300, 1)], request);
    assert.equal(offers.length, 0);
    assert.match(notes[0], /Nothing can deliver/);
  });

  it('uses at most three products', () => {
    const { offers } = buildOffers([short('a', 100, 1), short('b', 100, 1), short('c', 100, 1), short('d', 800, 1)], request);
    assert.equal(offers.length, 0); // needs 4 products
  });
});

describe('substitutes', () => {
  it('offers Valio-listed substitutes when nothing else works, marked for a human', () => {
    const { offers, notes } = buildOffers(
      [cand('orig', { fulfillable: false, onlyShort: false }), cand('s1', { substituteFor: 'orig', total: 1700 }), cand('s2', { substituteFor: 'orig', total: 1600 })],
      request
    );
    assert.deepEqual(offers.map((o) => o.id), ['s2', 's1']);
    assert.ok(offers.every((o) => o.isSubstitute && o.kinds[0] === 'substitute'));
    assert.equal(offers[0].lines[0].substituteFor, 'orig');
    assert.match(notes[0], /human/);
  });

  it('prefers a split of the requested products over a substitute', () => {
    const { offers } = buildOffers(
      [short('a', 600, 1), short('b', 600, 1.1), cand('s', { substituteFor: 'a', total: 1000 })],
      request
    );
    assert.deepEqual(offers[0].kinds, ['split']);
  });
});

describe('offer facts', () => {
  it('weights CO2 by amount and takes the lowest reliability across a split', () => {
    const { offers } = buildOffers(
      [short('a', 600, 1, { co2PerKg: 1, deliveryReliability: 0.9 }), short('b', 600, 1.1, { co2PerKg: 3, deliveryReliability: 0.7 })],
      request
    );
    assert.equal(offers[0].reliability, 0.7);
    assert.equal(offers[0].co2PerKg, 1.8); // (1 * 600 + 3 * 400) / 1000
  });
});

describe('buyer preference', () => {
  const three = () =>
    buildOffers(
      [
        cand('cheap', { unitPrice: 1.0, total: 1000, deliveryReliability: 0.8, co2PerKg: 3 }),
        cand('reliable', { unitPrice: 1.4, total: 1400, deliveryReliability: 1, co2PerKg: 2 }),
        cand('green', { unitPrice: 1.3, total: 1300, deliveryReliability: 0.9, co2PerKg: 0.5 }),
      ],
      request
    ).offers;

  it('keeps the cheapest first by default and puts the preferred offer first otherwise', () => {
    const offers = three();
    assert.deepEqual(applyPreference(offers, 'cheapest').map((o) => o.lines[0].productId), ['cheap', 'green', 'reliable']);
    assert.equal(applyPreference(offers, 'most_reliable')[0].lines[0].productId, 'reliable');
    assert.equal(applyPreference(offers, 'lowest_co2')[0].lines[0].productId, 'green');
  });
  it('keeps every offer and leaves the order alone when nothing earned the preferred kind', () => {
    const { offers } = buildOffers([short('a', 600, 1), short('b', 600, 1.1)], request);
    assert.deepEqual(applyPreference(offers, 'lowest_co2'), offers);
    assert.equal(applyPreference(three(), 'most_reliable').length, 3);
  });
});
