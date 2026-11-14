import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_OPTIONS,
  DEVIATION_REASON,
  detectDeviations,
  lineAmount,
  mad,
  median,
  tolerance,
  type DeviationOrderInput,
} from '../src/lib/deviation.ts';
import type { DeviationCheck, DeviationHistoryOrder, Product } from '../src/types/index.ts';

// --- fixtures -----------------------------------------------------------------

const MILK_CLAIMS = ['VEGETARIAN', 'LOW_SODIUM_SALT'];
const product = (id: string, name: string, over: Partial<Product> = {}, fat = 0, lactose = 4.9): Product =>
  ({
    id,
    nameFi: name,
    nameEn: name,
    category: '10400',
    salesUnit: 'ST',
    allergensContain: ['AM'],
    allergensMayContain: [],
    allergensFreeFrom: [],
    claims: MILK_CLAIMS,
    labels: [],
    nutrition: { FAT: { value: fat, unit: 'GRM' }, LACS: { value: lactose, unit: 'GRM' } },
    ...over,
  }) as Product;

const SKIMMED = product('skim', 'Valio skimmed milk 1 l');
const WHOLE = product('whole', 'Valio Luomu whole milk 1 l', { labels: ['EU_ORGANIC_FARMING'] }, 4.2, 4.7);
const SKIMMED_BOX = product('skim10', 'Valio skimmed milk 10 l novobox'); // same attributes, other pack size
const SEMI_LOOKALIKE = product('skimB', 'Other brand skimmed milk 1 l'); // same attributes, other brand
const CREAM = product('cream', 'Cooking cream 1 l', { category: '10401' }, 15, 0);
const PRODUCTS = new Map([SKIMMED, WHOLE, SKIMMED_BOX, SEMI_LOOKALIKE, CREAM].map((p) => [p.id, p]));

/** 2026-11-09 is a Monday. */
const MONDAY = Date.UTC(2026, 10, 9);
const dayString = (weeksAgo: number, weekday = 1) => new Date(MONDAY - weeksAgo * 7 * 86_400_000 + (weekday - 1) * 86_400_000).toISOString().slice(0, 10);

const histLine = (productId: string, name: string, amount: number, unit: 'L' | 'KG' | 'unit' = 'L') => ({ productId, name, amount, unit, total: amount * 0.9 });

/** One weekly order per entry, newest first: [liters of skimmed milk, ...]. Quantities default to exactly 1,000 L. */
const weekly = (amounts: number[], extra: Partial<DeviationHistoryOrder> = {}, id = 'skim', name = SKIMMED.nameEn as string): DeviationHistoryOrder[] =>
  amounts.map((a, i) => ({
    id: `h-${id}-${i}`,
    at: `${dayString(i + 1, 1)}T08:00:00.000Z`,
    deliveryDate: dayString(i, 1),
    total: a * 0.88,
    lines: [histLine(id, name, a)],
    ...extra,
  }));

const TWELVE = weekly(Array(12).fill(1000));

/** An order as the quote builds it: litres follow from price, price per litre and packs. */
const order = (lines: { productId: string; name: string; litres: number; lineTotal?: number }[], over: Partial<DeviationOrderInput> = {}): DeviationOrderInput => {
  const total = lines.reduce((s, l) => s + (l.lineTotal ?? l.litres * 0.88), 0);
  return {
    deliveryDate: dayString(0, 1),
    total,
    lines: lines.map((l) => ({
      productId: l.productId,
      name: l.name,
      quantity: l.litres,
      unitPrice: 0.88,
      comparisonPrice: 0.88,
      comparisonUnit: 'L',
      lineTotal: l.lineTotal ?? l.litres * 0.88,
    })),
    ...over,
  };
};
const skimmed = (litres: number) => order([{ productId: 'skim', name: 'Valio skimmed milk 1 l', litres }]);
const whole = (litres: number) => order([{ productId: 'whole', name: 'Valio Luomu whole milk 1 l', litres }]);

const row = (checks: DeviationCheck[], label: string) => checks.find((c) => c.label === label);

// --- statistics ---------------------------------------------------------------

describe('robust statistics', () => {
  it('median and MAD ignore one wild value', () => {
    assert.equal(median([1000, 1000, 1000, 1020, 980, 5000]), 1000);
    assert.equal(mad([1000, 1000, 1000, 1020, 980, 5000]), 10);
    assert.equal(median([4, 1, 3, 2]), 2.5);
  });
  it('tolerance is the larger of 3 MADs and 20 % of the median', () => {
    const calm = tolerance([1000, 1000, 1000, 1000]);
    assert.deepEqual([calm.median, calm.low, calm.high], [1000, 800, 1200]);
    const noisy = tolerance([400, 400, 1000, 1600, 1600]);
    assert.equal(noisy.median, 1000);
    assert.equal(noisy.high, 1000 + 3 * 600);
  });
  it('lineAmount gives litres or kilos from the price per litre, and packs without one', () => {
    assert.deepEqual(lineAmount({ quantity: 1000, unitPrice: 0.88, comparisonPrice: 0.88, comparisonUnit: 'L' }), { amount: 1000, unit: 'L' });
    assert.deepEqual(lineAmount({ quantity: 40, unitPrice: 3.3, comparisonPrice: 6.6, comparisonUnit: 'KG' }), { amount: 20, unit: 'KG' });
    assert.deepEqual(lineAmount({ quantity: 12, unitPrice: 5, comparisonPrice: null, comparisonUnit: null }), { amount: 12, unit: 'unit' });
  });
});

// --- the user's example -------------------------------------------------------

describe('the same order every week', () => {
  const usual = detectDeviations(TWELVE, skimmed(1000), PRODUCTS);

  it('has a baseline from 12 orders and flags nothing', () => {
    assert.equal(usual.hasBaseline, true);
    assert.equal(usual.basedOn, 12);
    assert.equal(usual.differing, 0);
    assert.deepEqual(usual.findings, []);
    assert.ok(usual.checks.every((c) => c.result === 'usual'));
  });

  it('shows the evidence in the usual column', () => {
    assert.equal(row(usual.checks, 'Quantity')?.usual, '1,000 L (800 to 1,200)');
    assert.equal(row(usual.checks, 'Quantity')?.thisOrder, '1,000 L');
    assert.equal(row(usual.checks, 'Delivery weekday')?.usual, 'Monday, 12 of 12');
    assert.equal(row(usual.checks, 'Lactose per 100 g')?.usual, '4.9 g');
    assert.equal(row(usual.checks, 'Allergens')?.usual, 'milk');
  });

  it('1,000 L whole milk instead of skimmed is one finding, with fat +4.2 g', () => {
    const r = detectDeviations(TWELVE, whole(1000), PRODUCTS);
    assert.equal(r.differing, 1);
    const fat = row(r.checks, 'Fat per 100 g');
    assert.deepEqual([fat?.usual, fat?.thisOrder, fat?.result, fat?.detail], ['0 g', '4.2 g', 'review', '+4.2 g']);
    assert.equal(row(r.checks, 'Product')?.usual, 'Valio skimmed milk 1 l');
    assert.equal(row(r.checks, 'Product')?.thisOrder, 'Valio Luomu whole milk 1 l');
    assert.equal(row(r.checks, 'Product')?.result, 'review');
    assert.equal(row(r.checks, 'Lactose per 100 g')?.result, 'usual', 'a 0.2 g lactose difference is under the 0.5 g threshold');
    assert.equal(row(r.checks, 'Diet claims')?.detail, '+ organic');
    // The product row and its attribute rows are ONE finding; the quantity is the same, so it matches.
    const swap = r.checks.filter((c) => c.group === 'swap:whole');
    assert.ok(swap.length >= 4);
    assert.equal(r.differing, 1);
    assert.equal(row(r.checks, 'Quantity')?.result, 'usual');
    assert.match(r.findings[0], /Valio Luomu whole milk 1 l instead of Valio skimmed milk 1 l/);
    assert.match(r.findings[0], /fat \+4\.2 g per 100 g/);
  });

  it('counts the swap once however many attribute rows differ', () => {
    const r = detectDeviations(TWELVE, whole(1000), PRODUCTS);
    const reviewRows = r.checks.filter((c) => c.result === 'review').length;
    assert.ok(reviewRows >= 3, 'product, fat and claims rows all differ');
    assert.equal(r.differing, 1);
    assert.equal(r.total, new Set(r.checks.map((c) => c.group ?? c.id)).size);
  });

  it('1,000 L to 1,100 L does not flag; 3,000 L does', () => {
    assert.equal(detectDeviations(TWELVE, skimmed(1100), PRODUCTS).differing, 0);
    const big = detectDeviations(TWELVE, skimmed(3000), PRODUCTS);
    assert.equal(big.differing, 1);
    const q = row(big.checks, 'Quantity');
    assert.equal(q?.result, 'review');
    assert.equal(q?.detail, '3x');
    assert.match(big.findings[0], /3,000 L instead of the usual 1,000 L/);
  });

  it('10x the quantity and a half both flag', () => {
    assert.equal(detectDeviations(TWELVE, skimmed(10000), PRODUCTS).differing, 1);
    assert.equal(detectDeviations(TWELVE, skimmed(400), PRODUCTS).differing, 1);
  });

  it('a +20 % holiday week does not flag, and +25 % does', () => {
    assert.equal(detectDeviations(TWELVE, skimmed(1200), PRODUCTS).differing, 0);
    assert.equal(detectDeviations(TWELVE, skimmed(1250), PRODUCTS).differing, 1);
  });

  it('ratio of 2x flags even when a noisy history makes the tolerance wide', () => {
    const noisy = weekly([400, 1600, 400, 1600, 400, 1600, 1000, 1000, 1000, 1000, 1000, 1000]);
    assert.equal(detectDeviations(noisy, skimmed(1900), PRODUCTS).differing, 0, 'inside the tolerance and under 2x');
    assert.equal(detectDeviations(noisy, skimmed(2000), PRODUCTS).differing, 1, 'exactly 2x');
  });
});

describe('what is not a reason by itself', () => {
  it('a different delivery weekday is information only', () => {
    const r = detectDeviations(TWELVE, skimmed(1000), PRODUCTS);
    assert.equal(r.differing, 0);
    const wednesday = detectDeviations(TWELVE, order([{ productId: 'skim', name: 'x', litres: 1000 }], { deliveryDate: dayString(0, 3) }), PRODUCTS);
    assert.equal(wednesday.differing, 0);
    const d = row(wednesday.checks, 'Delivery weekday');
    assert.deepEqual([d?.usual, d?.thisOrder, d?.result], ['Monday, 12 of 12', 'Wednesday', 'info']);
  });

  it('an order total far outside the usual range is information only, in percent', () => {
    // The usual total is 880 (1,000 L at 0.88): 1,000 L plus 250 EUR of something small is 28 % more.
    const r = detectDeviations(TWELVE, order([{ productId: 'skim', name: 'x', litres: 1000 }], { total: 1130 }), PRODUCTS);
    const t = row(r.checks, 'Order total');
    assert.equal(t?.usual, '€880 (€704 to €1,056)');
    assert.equal(t?.result, 'info');
    assert.equal(t?.detail, '+28%');
    assert.equal(r.differing, 0);
  });

  it('the same product in another pack size is the same amount, not a swap', () => {
    const boxes = weekly(Array(12).fill(1000), {}, 'skim10', 'Valio skimmed milk 10 l novobox');
    const tenLiterBoxes: DeviationOrderInput = {
      deliveryDate: dayString(0, 1),
      total: 880,
      lines: [{ productId: 'skim10', name: 'box', quantity: 100, unitPrice: 8.8, comparisonPrice: 0.88, comparisonUnit: 'L', lineTotal: 880 }],
    };
    const r = detectDeviations(boxes, tenLiterBoxes, PRODUCTS);
    assert.equal(r.differing, 0);
    assert.equal(row(r.checks, 'Quantity')?.thisOrder, '1,000 L');
    // Ten 1 l packs per litre instead of the box: a swap between pack sizes, same attributes, same litres.
    const swapped = detectDeviations(boxes, skimmed(1000), PRODUCTS);
    assert.equal(swapped.differing, 0);
    assert.equal(row(swapped.checks, 'Product')?.result, 'info');
    assert.equal(row(swapped.checks, 'Product')?.detail, 'Same attributes');
    assert.equal(row(swapped.checks, 'Quantity')?.result, 'usual');
  });

  it('another brand with the same attributes is information, not a review', () => {
    const r = detectDeviations(TWELVE, order([{ productId: 'skimB', name: 'x', litres: 1000 }]), PRODUCTS);
    assert.equal(r.differing, 0);
    assert.equal(row(r.checks, 'Product')?.result, 'info');
  });

  it('an unrelated one-off order in a new week does not push a week of the standing order out of the baseline', () => {
    const oneOff: DeviationHistoryOrder = { id: 'x', at: `${dayString(0, 1)}T08:00:00.000Z`, deliveryDate: dayString(0, 3), total: 90, lines: [histLine('cream', 'Cooking cream 1 l', 100)] };
    const r = detectDeviations([oneOff, ...TWELVE], skimmed(1000), PRODUCTS);
    assert.equal(r.basedOn, 12);
    assert.equal(r.differing, 0);
  });

  it('a usual product missing from this order is not a finding', () => {
    const history = [...weekly(Array(12).fill(1000)).map((h, i) => ({ ...h, lines: [...h.lines, histLine('cream', 'Cooking cream 1 l', 30)], id: `c${i}` }))];
    const r = detectDeviations(history, skimmed(1000), PRODUCTS);
    assert.equal(r.differing, 0);
  });
});

describe('product attributes', () => {
  const swapTo = (p: Product) => detectDeviations(TWELVE, order([{ productId: p.id, name: p.nameEn as string, litres: 1000 }]), new Map([...PRODUCTS, [p.id, p]]));

  it('fat differing by 0.5 g flags, by 0.4 g does not', () => {
    assert.equal(swapTo(product('f5', 'Fat 0.5', {}, 0.5, 4.9)).differing, 1);
    assert.equal(swapTo(product('f4', 'Fat 0.4', {}, 0.4, 4.9)).differing, 0);
  });
  it('lactose differing by 0.5 g flags (a lactose-free swap)', () => {
    const r = swapTo(product('lf', 'Lactose free', { claims: [...MILK_CLAIMS, 'FREE_FROM_LACTOSE'] }, 0, 0));
    assert.equal(r.differing, 1);
    assert.equal(row(r.checks, 'Lactose per 100 g')?.detail, '-4.9 g');
    assert.equal(row(r.checks, 'Diet claims')?.detail, '+ lactose free');
  });
  it('a different allergen set flags', () => {
    const r = swapTo(product('al', 'Other allergens', { allergensContain: ['AM', 'AS'] }));
    assert.equal(r.differing, 1);
    assert.equal(row(r.checks, 'Allergens')?.thisOrder, 'milk, sesame');
  });
  it('different claims alone (organic, vegan) flag', () => {
    assert.equal(swapTo(product('org', 'Organic', { labels: ['EU_ORGANIC_FARMING'] })).differing, 1);
    assert.equal(swapTo(product('vg', 'Vegan', { claims: [...MILK_CLAIMS, 'VEGAN'] })).differing, 1);
  });
  it('missing nutrient data is shown but is not a reason', () => {
    const r = swapTo(product('nd', 'No data', { nutrition: {} }));
    assert.equal(row(r.checks, 'Fat per 100 g')?.result, 'info');
    assert.equal(r.differing, 0);
  });
});

describe('new items', () => {
  const cheese = product('cheese', 'Gouda 1 kg', { category: '10600', salesUnit: 'KI' }, 28, 0);
  const withCheese = (cheeseTotal: number) => {
    const o = order([{ productId: 'skim', name: 'x', litres: 1000 }]);
    const total = o.total + cheeseTotal;
    return {
      ...o,
      total,
      lines: [...o.lines, { productId: 'cheese', name: 'Gouda 1 kg', quantity: 1, unitPrice: cheeseTotal, comparisonPrice: null, comparisonUnit: null, lineTotal: cheeseTotal }],
    };
  };
  const map = new Map([...PRODUCTS, ['cheese', cheese]]);

  it('a new category above 25 % of the order total is a review', () => {
    const r = detectDeviations(TWELVE, withCheese(500), map);
    assert.equal(r.differing, 1);
    const c = row(r.checks, 'New category');
    assert.equal(c?.result, 'review');
    assert.equal(c?.usual, 'Category not ordered before');
    assert.match(r.findings[0], /Gouda 1 kg is in a new category for this buyer and makes up 36% of the order/);
  });
  it('a small new item is information only', () => {
    const r = detectDeviations(TWELVE, withCheese(40), map);
    assert.equal(r.differing, 0);
    assert.equal(row(r.checks, 'New category')?.result, 'info');
  });
});

describe('cold start', () => {
  it('fewer than 4 past orders gives no baseline and flags nothing', () => {
    const r = detectDeviations(weekly([1000, 1000, 1000]), whole(5000), PRODUCTS);
    assert.deepEqual([r.hasBaseline, r.differing, r.total, r.checks.length], [false, 0, 0, 0]);
    assert.equal(r.basedOn, 3);
  });
  it('no history at all gives no baseline', () => {
    const r = detectDeviations([], whole(5000), PRODUCTS);
    assert.deepEqual([r.hasBaseline, r.basedOn, r.differing], [false, 0, 0]);
  });
  it('4 orders in 4 weeks is enough', () => {
    const r = detectDeviations(weekly([1000, 1000, 1000, 1000]), whole(1000), PRODUCTS);
    assert.equal(r.hasBaseline, true);
    assert.equal(r.differing, 1);
  });
  it('4 orders in the same week are not a standing order (needs 3 different weeks)', () => {
    const sameWeek = weekly([1000, 1000, 1000, 1000]).map((h) => ({ ...h, deliveryDate: dayString(0, 1) }));
    assert.equal(detectDeviations(sameWeek, whole(1000), PRODUCTS).hasBaseline, false);
  });
  it('orders without an amount (older synthetic rows) teach nothing', () => {
    const legacy = weekly(Array(12).fill(1000)).map((h) => ({ ...h, lines: [{ productId: 'skim', name: 'x', amount: Number.NaN, unit: 'unit' as const }] }));
    assert.equal(detectDeviations(legacy, whole(1000), PRODUCTS).hasBaseline, false);
  });
});

describe('what counts as a normal order', () => {
  const recent = (n: number, extra: Partial<DeviationHistoryOrder>) =>
    weekly(Array(n).fill(1000), extra, 'whole', 'Valio Luomu whole milk 1 l').map((h, i) => ({ ...h, id: `w${i}`, deliveryDate: dayString(i, 3), at: `${dayString(i + 1, 1)}T09:00:00.000Z` }));

  it('flagged orders that were approved do not poison the baseline', () => {
    const history = [...recent(3, { flagged: true }), ...TWELVE];
    const r = detectDeviations(history, whole(1000), PRODUCTS);
    assert.equal(r.differing, 1, 'whole milk is still unusual after three approved one-offs');
    assert.equal(r.basedOn, 12, 'and they are not in the 12 orders it is based on');
    assert.equal(row(r.checks, 'Delivery weekday')?.usual, 'Monday, 12 of 12');
  });

  it('an order accepted as the new normal moves the baseline', () => {
    const before = detectDeviations(TWELVE, whole(1000), PRODUCTS);
    assert.equal(before.differing, 1);
    // One accepted order is enough: whole milk is now a usual product, at the accepted quantity.
    const accepted = [{ ...recent(1, { flagged: true, acceptedAsNormal: true })[0], deliveryDate: dayString(0, 1), id: 'acc' }, ...TWELVE];
    const after = detectDeviations(accepted, whole(1000), PRODUCTS);
    assert.equal(after.differing, 0);
    assert.equal(row(after.checks, 'Product')?.detail, 'Same product');
    // The accepted quantity is the new reference: three times as much is still unusual.
    assert.equal(detectDeviations(accepted, whole(3000), PRODUCTS).differing, 1);
  });
});

describe('accepting a quantity as the new normal', () => {
  const wholeOrders = (amounts: number[], extra: Partial<DeviationHistoryOrder> = {}, offset = 0) =>
    amounts.map((a, i) => ({
      id: `wh-${offset + i}-${extra.acceptedAsNormal ? 'acc' : 'n'}`,
      at: `${dayString(offset + i + 1, 1)}T09:00:00.000Z`,
      deliveryDate: dayString(offset + i, 1),
      total: a * 0.9,
      lines: [histLine('whole', 'Valio Luomu whole milk 1 l', a)],
      ...extra,
    }));

  it('replaces the earlier pattern of that product, so a few small old orders do not outvote it', () => {
    const small = wholeOrders([100, 100, 100, 100, 100, 100], {}, 1);
    const accepted = wholeOrders([1000], { flagged: true, acceptedAsNormal: true }, 0);
    const history = [...accepted, ...small, ...TWELVE];
    assert.equal(detectDeviations(history, whole(1000), PRODUCTS).differing, 0);
    assert.equal(row(detectDeviations(history, whole(1000), PRODUCTS).checks, 'Quantity')?.usual, '1,000 L (800 to 1,200)');
    assert.equal(detectDeviations(history, whole(100), PRODUCTS).differing, 1, 'the old quantity is now the unusual one');
  });

  it('an accepted order whose lines are in line with the history leaves that history alone', () => {
    const acceptedMixed: DeviationHistoryOrder = { ...TWELVE[0], id: 'mixed', flagged: true, acceptedAsNormal: true, at: `${dayString(0, 1)}T10:00:00.000Z`, deliveryDate: dayString(0, 1) };
    const r = detectDeviations([acceptedMixed, ...TWELVE.slice(1)], skimmed(1000), PRODUCTS);
    assert.equal(r.differing, 0);
    assert.equal(r.basedOn, 12);
  });
});

describe('options', () => {
  it('thresholds are exported constants and one options object', () => {
    assert.equal(DEFAULT_OPTIONS.windowWeeks, 12);
    assert.equal(DEFAULT_OPTIONS.minOrdersForBaseline, 4);
    assert.equal(DEFAULT_OPTIONS.tolerancePctFloor, 0.2);
    assert.equal(DEFAULT_OPTIONS.fatDiffG, 0.5);
    assert.equal(DEFAULT_OPTIONS.newItemShare, 0.25);
  });
  it('a stricter tolerance flags a 10 % change', () => {
    assert.equal(detectDeviations(TWELVE, skimmed(1100), PRODUCTS).differing, 0);
    assert.equal(detectDeviations(TWELVE, skimmed(1100), PRODUCTS, { tolerancePctFloor: 0.05 }).differing, 1);
  });
  it('only the most recent weeks are read', () => {
    // Twelve old weeks of 5,000 L, then twelve recent weeks of 1,000 L: the old ones are outside the window.
    const old = weekly(Array(12).fill(5000)).map((h, i) => ({ ...h, id: `old${i}`, deliveryDate: dayString(i + 12, 1), at: `${dayString(i + 13, 1)}T08:00:00.000Z` }));
    assert.equal(detectDeviations([...TWELVE, ...old], skimmed(1000), PRODUCTS).differing, 0);
    // Read all 24 weeks and the usual quantity is 3,000 L: 1,000 L is now a third of it.
    assert.equal(detectDeviations([...TWELVE, ...old], skimmed(1000), PRODUCTS, { windowWeeks: 24 }).differing, 1);
  });
  it('the agent reason is one fixed sentence without numbers', () => {
    assert.equal(DEVIATION_REASON, "Needs approval: differs from this buyer's usual orders.");
    assert.equal(/\d/.test(DEVIATION_REASON), false);
  });
});
