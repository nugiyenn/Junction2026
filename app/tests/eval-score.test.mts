import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyError, compareAgreement, percentile, scoreOutput, summarizeRuns } from '../src/lib/eval-score.ts';
import type { EvalCase, EvalRun, PurchaseRequest } from '../src/types/index.ts';

const expected: EvalCase['expected'] = {
  productAny: ['milk', 'maito'],
  amount: 500,
  amountUnit: 'L',
  deliveryDate: '2026-11-19',
  requiredClaims: ['FREE_FROM_LACTOSE', 'LOW_FAT'],
};
const good: PurchaseRequest = { product: 'Lactose-free Milk', amount: 500, amountUnit: 'L', deliveryDate: '2026-11-19', requiredClaims: ['LOW_FAT', 'FREE_FROM_LACTOSE'] };

const run = (caseId: string, output: PurchaseRequest | null, latencyMs = 1000, errorKind: EvalRun['errorKind'] = null): EvalRun => ({
  caseId,
  ok: output !== null,
  latencyMs,
  output,
  error: output ? null : 'failed',
  errorKind,
  correct: output ? scoreOutput(expected, output) : null,
});

describe('scoreOutput', () => {
  it('accepts a correct output: product keyword case-insensitive, claims in any order', () => {
    assert.deepEqual(Object.values(scoreOutput(expected, good)), [true, true, true, true, true]);
  });

  it('marks each wrong field separately', () => {
    const s = scoreOutput(expected, { ...good, product: 'cream', amount: 0.5, amountUnit: 'KG', deliveryDate: '2026-11-20', requiredClaims: ['LOW_FAT'] });
    assert.deepEqual(s, { product: false, amount: false, amountUnit: false, deliveryDate: false, requiredClaims: false });
  });

  it('treats an extra claim as wrong', () => {
    assert.equal(scoreOutput(expected, { ...good, requiredClaims: ['LOW_FAT', 'FREE_FROM_LACTOSE', 'VEGAN'] }).requiredClaims, false);
  });
});

describe('classifyError', () => {
  it('separates timeouts, invalid output and other failures', () => {
    assert.equal(classifyError(new Error('Nemotron timed out after 60s')), 'timeout');
    assert.equal(classifyError(new Error('Request timed out.')), 'timeout');
    assert.equal(classifyError(new SyntaxError('Unexpected token')), 'invalid_output');
    assert.equal(classifyError(Object.assign(new Error('bad'), { name: 'ZodError' })), 'invalid_output');
    assert.equal(classifyError(new Error('Gemma returned no JSON: sorry')), 'invalid_output');
    assert.equal(classifyError(new Error('Nemotron HTTP 401: nope')), 'error');
  });
});

describe('percentile', () => {
  it('uses nearest rank and is null when empty', () => {
    assert.equal(percentile([], 50), null);
    assert.equal(percentile([100, 200, 300, 400], 50), 200);
    assert.equal(percentile([100, 200, 300, 400], 95), 400);
    assert.equal(percentile([700], 95), 700);
  });
});

describe('summarizeRuns', () => {
  it('counts failed runs as invalid and wrong, and takes latency from valid runs only', () => {
    const runs = [
      run('a', good, 1000),
      run('b', { ...good, amount: 5 }, 3000),
      run('c', null, 60000, 'timeout'),
      run('d', null, 200, 'invalid_output'),
    ];
    const s = summarizeRuns(runs);
    assert.equal(s.attempts, 4);
    assert.equal(s.valid, 2);
    assert.equal(s.validRate, 0.5);
    assert.equal(s.fieldAccuracy.amount, 0.25);
    assert.equal(s.fieldAccuracy.product, 0.5);
    assert.equal(s.exactRate, 0.25);
    assert.equal(s.latencyP50Ms, 1000);
    assert.equal(s.latencyP95Ms, 3000);
    assert.deepEqual(s.errors, { timeout: 1, invalid_output: 1, error: 0 });
  });

  it('has null latency when nothing was valid', () => {
    const s = summarizeRuns([run('a', null, 10, 'error')]);
    assert.equal(s.latencyP50Ms, null);
    assert.equal(s.validRate, 0);
  });
});

describe('compareAgreement', () => {
  const cases: EvalCase[] = ['a', 'b', 'c'].map((id) => ({ id, text: id, note: '', expected }));

  it('flags a disagreement on amount or unit and names the models that are wrong', () => {
    const { agreement, agreementSummary } = compareAgreement(cases, [
      { id: 'm1', runs: [run('a', good), run('b', good), run('c', good)] },
      { id: 'm2', runs: [run('a', good), run('b', { ...good, amountUnit: 'unit' }), run('c', null, 1, 'timeout')] },
      { id: 'm3', runs: [] },
    ]);
    assert.equal(agreement[0].agree, true);
    assert.equal(agreement[1].agree, false);
    assert.deepEqual(agreement[1].wrong, ['m2']);
    assert.equal(agreement[2].agree, null, 'only one model answered, so nothing to compare');
    assert.deepEqual(agreement[2].answers, { m1: [500, 'L'], m2: null, m3: null });
    assert.deepEqual(agreementSummary, { comparable: 2, agreed: 1, allCorrect: 1 });
  });

  it('reports models that agree with each other but not with the label', () => {
    const wrong = { ...good, amount: 50 };
    const { agreement } = compareAgreement(cases.slice(0, 1), [
      { id: 'm1', runs: [run('a', wrong)] },
      { id: 'm2', runs: [run('a', wrong)] },
    ]);
    assert.equal(agreement[0].agree, true);
    assert.deepEqual(agreement[0].wrong, ['m1', 'm2']);
  });
});
