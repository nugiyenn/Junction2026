import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { exposeLine, exposeOrder, exposeQuote, stockView } from '../src/lib/exposure.ts';
import type { Order, Quote, QuoteLine } from '../src/types/index.ts';

const line = (over: Partial<QuoteLine> = {}): QuoteLine => ({
  productId: 'p1',
  name: 'Milk',
  quantity: 100,
  salesUnit: 'ST',
  unitPrice: 1.4,
  unitPriceWithTax: 1.59,
  comparisonPrice: 1.4,
  comparisonUnit: 'L',
  lineTotal: 140,
  lineTotalWithTax: 159,
  availableAmount: 51234,
  availableDate: '2026-11-16',
  closingTime: '2026-11-15T17:00:00+0200',
  logisticModel: 'Stock',
  fulfillable: true,
  issues: [],
  substitutes: [],
  internal: {
    listPrice: 2.02,
    discountPct: 30.7,
    netPriceFound: true,
    availableAmount: 51234,
    vendorName: 'VALIO OY',
    category: '22540',
  },
  ...over,
});

describe('exposeLine: what the agent never gets', () => {
  it('removes the exact stock, the list price, the discount, the supplier and the category', () => {
    const json = JSON.stringify(exposeLine(line()));
    for (const secret of ['51234', '2.02', '30.7', 'VALIO OY', '22540', 'listPrice', 'discountPct', 'vendorName', 'netPriceFound', 'internal', 'availableAmount']) {
      assert.equal(json.includes(secret), false, `leaked: ${secret}`);
    }
  });

  it('keeps what the agent needs: its own price, the total, the cut-off and the date', () => {
    const e = exposeLine(line());
    assert.equal(e.unitPrice, 1.4);
    assert.equal(e.lineTotal, 140);
    assert.equal(e.closingTime, '2026-11-15T17:00:00+0200');
    assert.equal(e.availableDate, '2026-11-16');
    assert.equal(e.comparisonPrice, 1.4);
  });

  it('rewrites the "Only N available" issue so it does not name the stock', () => {
    const e = exposeLine(line({ availableAmount: 51, quantity: 100, fulfillable: false, issues: ['Only 51 ST available.', 'Order cut-off passed at x.'] }));
    assert.deepEqual(e.issues, ['Not enough stock for the full quantity.', 'Order cut-off passed at x.']);
    assert.equal(JSON.stringify(e).includes('51'), false);
  });
});

describe('stockView', () => {
  it('says ample when stock is well above the quantity, limited when it is close, and cannot fill below it', () => {
    assert.deepEqual(stockView(line({ quantity: 100, internal: { ...line().internal!, availableAmount: 1000 } })), { canFill: true, confidence: 'confirmed', level: 'ample' });
    assert.deepEqual(stockView(line({ quantity: 100, internal: { ...line().internal!, availableAmount: 150 } })), { canFill: true, confidence: 'confirmed', level: 'limited' });
    assert.deepEqual(stockView(line({ quantity: 100, internal: { ...line().internal!, availableAmount: 40 } })), { canFill: false, confidence: 'confirmed', level: 'limited' });
  });

  it('marks Terminal stock as supplier-unconfirmed with an unknown level', () => {
    const v = stockView(line({ logisticModel: 'Terminal', availableAmount: null, internal: { ...line().internal!, availableAmount: null } }));
    assert.deepEqual(v, { canFill: true, confidence: 'supplier_unconfirmed', level: 'unknown' });
  });

  it('reports canFill false for a line that cannot be fulfilled when no stock number exists', () => {
    const v = stockView(line({ logisticModel: 'Terminal', fulfillable: false, availableAmount: null, internal: { ...line().internal!, availableAmount: null } }));
    assert.equal(v.canFill, false);
  });
});

describe('exposeQuote and exposeOrder', () => {
  const quote = { id: 'q', mandateId: 'm', lines: [line(), line({ productId: 'p2' })], total: 280 } as Quote;
  it('exposes every line of a quote and keeps the rest of the quote', () => {
    const e = exposeQuote(quote);
    assert.equal(e.lines.length, 2);
    assert.equal(e.total, 280);
    assert.equal(JSON.stringify(e).includes('51234'), false);
  });
  it('exposes every line of an order', () => {
    const e = exposeOrder({ id: 'o', lines: [line()], status: 'confirmed' } as Order);
    assert.equal(JSON.stringify(e).includes('VALIO OY'), false);
    assert.equal(e.status, 'confirmed');
  });
  it('does not change the original, which Valio keeps whole', () => {
    exposeQuote(quote);
    assert.equal(quote.lines[0].availableAmount, 51234);
    assert.equal(quote.lines[0].internal?.vendorName, 'VALIO OY');
  });
});
