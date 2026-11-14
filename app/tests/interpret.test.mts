import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compareInterpretations, weekdayDate } from '../src/lib/interpret.ts';
import type { PurchaseRequest } from '../src/types/index.ts';

// 2026-11-14 is a Saturday.
const SATURDAY = '2026-11-14';

describe('weekdayDate', () => {
  it('resolves English weekday names to the next such day after today', () => {
    assert.equal(weekdayDate('I need 1,000 litres of milk by Monday.', SATURDAY), '2026-11-16');
    assert.equal(weekdayDate('delivery on friday please', SATURDAY), '2026-11-20');
    assert.equal(weekdayDate('by Sunday', SATURDAY), '2026-11-15');
  });
  it('counts today\'s own weekday as a week away', () => {
    assert.equal(weekdayDate('by Saturday', SATURDAY), '2026-11-21');
  });
  it('understands Finnish names and their endings', () => {
    assert.equal(weekdayDate('Tarvitsen 2 tonnia perunaa maanantaiksi', SATURDAY), '2026-11-16');
    assert.equal(weekdayDate('torstaina kiitos', SATURDAY), '2026-11-19');
  });
  it('uses the first weekday when several are named', () => {
    assert.equal(weekdayDate('Tuesday, or at the latest Thursday', SATURDAY), '2026-11-17');
  });
  it('returns null with no weekday or with an explicit date', () => {
    assert.equal(weekdayDate('ten cases of oat milk', SATURDAY), null);
    assert.equal(weekdayDate('by Monday 16.11.', SATURDAY), null);
    assert.equal(weekdayDate('on 2026-11-20 (Friday)', SATURDAY), null);
    assert.equal(weekdayDate('by 20 November, a Friday', SATURDAY), null);
  });
  it('works across a month and year boundary', () => {
    assert.equal(weekdayDate('by Thursday', '2026-12-30'), '2026-12-31');
    assert.equal(weekdayDate('by Friday', '2026-12-30'), '2027-01-01');
  });
});

describe('compareInterpretations', () => {
  const base: PurchaseRequest = { product: 'milk', amount: 100, amountUnit: 'L', deliveryDate: '2026-11-16', requiredClaims: ['FREE_FROM_LACTOSE'] };
  it('finds no difference between identical readings, or when only the wording and claims differ', () => {
    assert.deepEqual(compareInterpretations(base, { ...base }), []);
    assert.deepEqual(compareInterpretations(base, { ...base, product: 'lactose free milk drink', requiredClaims: ['FREE_FROM_LACTOSE', 'VEGAN'] }), []);
  });
  it('reports a different amount, unit or delivery date', () => {
    assert.deepEqual(compareInterpretations(base, { ...base, amount: 1000 }), ['amount: 100 vs 1000']);
    assert.deepEqual(compareInterpretations({ ...base, amount: 2, amountUnit: 'KG' }, { ...base, amount: 2000, amountUnit: 'KG' }), ['amount: 2 vs 2000']);
    assert.deepEqual(compareInterpretations(base, { ...base, amountUnit: 'KG' }), ['unit: L vs KG']);
    assert.deepEqual(compareInterpretations(base, { ...base, deliveryDate: '2026-11-17' }), ['delivery date: 2026-11-16 vs 2026-11-17']);
  });
  it('lists every difference', () => {
    assert.equal(compareInterpretations(base, { ...base, amount: 10, deliveryDate: '2026-11-18' }).length, 2);
  });
});
