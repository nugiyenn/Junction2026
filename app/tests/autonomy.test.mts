import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AcceptBody, pickSuggestion } from '../src/lib/autonomy-accept.ts';
import { historyNote, suggestAutonomy, suggestionId, trajectory, type AutonomyInput } from '../src/lib/autonomy-core.ts';
import { requireApprover } from '../src/lib/auth.ts';
import type { AutonomyOrder } from '../src/types/index.ts';

const NOW = '2026-11-14T12:00:00.000Z';
const DAY = 86_400_000;
/** An instant `daysAgo` days before NOW, spread by `i` so orders stay in a stable order. */
const at = (daysAgo: number, i = 0) => new Date(Date.parse(NOW) - daysAgo * DAY + i * 60_000).toISOString();
const order = (daysAgo: number, total: number, outcome: AutonomyOrder['outcome'], synthetic = true, i = 0): AutonomyOrder => ({ at: at(daysAgo, i), total, outcome, synthetic });

/** n approved reviewed orders with totals 210, 220, ... (above a 200 limit), oldest first, over the last 60 days. */
const approved = (n: number, from = 210): AutonomyOrder[] => Array.from({ length: n }, (_, i) => order(60 - i, from + i * 10, 'approved'));

const run = (orders: AutonomyOrder[], over: Partial<AutonomyInput> = {}) =>
  suggestAutonomy({ mandateId: 'm1', autoApproveLimitEur: 200, maxOrderEur: 5000, orders, now: NOW, ...over });

describe('earned autonomy: raise', () => {
  it('raises the limit when a person approved every reviewed order within reach', () => {
    const r = run([...approved(14), order(70, 100, 'auto_approved'), order(5, 150, 'auto_approved')]); // reviewed totals 210..340
    assert.equal(r.suggestions.length, 1);
    const s = r.suggestions[0];
    assert.equal(s.kind, 'raise_auto_limit');
    assert.equal(s.field, 'autoApproveLimitEur');
    assert.equal(s.from, 200);
    assert.equal(s.to, 400); // the highest step (x2): nothing was declined up to 400
  });

  it('steps x2 (400) when all reviewed orders up to 400 were approved', () => {
    const s = run(approved(20)).suggestions[0]; // totals 210..400
    assert.equal(s.to, 400);
    assert.deepEqual({ orders: s.evidence.orders, approved: s.evidence.approved, declined: s.evidence.declined, windowDays: s.evidence.windowDays }, { orders: 20, approved: 20, declined: 0, windowDays: 90 });
    assert.equal(s.evidence.syntheticShare, 1);
    assert.match(s.reason, /approved all 20/);
    assert.equal(s.effect.autoApprovedShareBefore, 0);
    assert.equal(s.effect.autoApprovedShareAfter, 1);
  });

  it('falls back to a lower step when a decline sits between the steps', () => {
    // 12 approved up to 260, two more at 320 and 340, one decline at 380: x2 (400) includes it, x1.5 (300) does not.
    const orders = [...Array.from({ length: 12 }, (_, i) => order(50 - i, 205 + i * 5, 'approved')), order(9, 320, 'approved'), order(8, 340, 'approved'), order(3, 380, 'declined')];
    const s = run(orders).suggestions[0];
    assert.equal(s.to, 300);
    assert.equal(s.evidence.orders, 12);
  });

  it('does not raise after a decline within reach, and says so', () => {
    const r = run([...approved(14), order(3, 240, 'declined')]);
    assert.deepEqual(r.suggestions, []);
    assert.match(r.summary.noSuggestionReason ?? '', /declined 1 of/);
  });

  it('needs at least 12 reviewed orders up to the limit (boundary 12 vs 11)', () => {
    const twelve = Array.from({ length: 12 }, (_, i) => order(40 - i, 205 + i * 3, 'approved')); // 205..238, all within reach of every step
    assert.equal(run(twelve).suggestions[0].to, 400);
    assert.equal(run(twelve).suggestions[0].evidence.orders, 12);
    const eleven = twelve.slice(1);
    assert.match(run(eleven).summary.noSuggestionReason ?? '', /Too little history: 11/);
    // 12 reviewed in all, but only 11 of them within reach of the smallest step: no raise.
    const spread = [...eleven, order(1, 4000, 'approved')];
    const r = run(spread);
    assert.deepEqual(r.suggestions, []);
    assert.match(r.summary.noSuggestionReason ?? '', /Not yet: 11 reviewed orders up to €250/);
  });

  it('never goes above half of the maximum order value', () => {
    const near = Array.from({ length: 13 }, (_, i) => order(40 - i, 2410 + i * 5, 'approved'));
    const s = run(near, { autoApproveLimitEur: 2400 }).suggestions[0];
    assert.equal(s.to, 2500);
    const r = run(near, { autoApproveLimitEur: 2500 });
    assert.deepEqual(r.suggestions, []);
    assert.match(r.summary.noSuggestionReason ?? '', /half the maximum/);
    // a lower maximum lowers the cap
    assert.equal(run(approved(20), { maxOrderEur: 700 }).suggestions[0].to, 350);
  });

  it('ignores decisions older than 90 days and before the last limit change', () => {
    const old = Array.from({ length: 20 }, (_, i) => order(120 + i, 210 + i, 'approved'));
    assert.match(run(old).summary.noSuggestionReason ?? '', /Too little history: 0/);
    const r = run(approved(20), { since: at(30) }); // only decisions in the last 30 days count: about half
    assert.match(r.summary.noSuggestionReason ?? '', /since the last limit change/);
  });

  it('says why there is too little history', () => {
    const r = run(approved(5));
    assert.deepEqual(r.suggestions, []);
    assert.match(r.summary.noSuggestionReason ?? '', /Too little history: 5 reviewed orders .* 12 needed/);
  });

  it('counts pending orders and orders in the future as nothing', () => {
    const r = run([...approved(20), order(1, 300, 'pending'), order(-3, 300, 'declined')]);
    assert.equal(r.suggestions[0].to, 400);
  });
});

describe('earned autonomy: lower', () => {
  // 16 approved at 100..250, then two declines: p75 of the confirmed totals is 212.5, rounded down to 210.
  const base = Array.from({ length: 16 }, (_, i) => order(40 - i, 100 + i * 10, 'approved'));
  const declines = [order(3, 600, 'declined'), order(2, 700, 'declined')];

  it('suggests about the 75th percentile of confirmed orders after two declines in the last ten', () => {
    const r = run([...base, ...declines], { autoApproveLimitEur: 500 });
    const s = r.suggestions[0];
    assert.equal(s.kind, 'lower_auto_limit');
    assert.equal(s.from, 500);
    assert.equal(s.to, 210);
    assert.deepEqual({ orders: s.evidence.orders, approved: s.evidence.approved, declined: s.evidence.declined }, { orders: 10, approved: 8, declined: 2 });
    assert.equal(s.effect.autoApprovedShareBefore, 16 / 18);
    assert.equal(s.effect.autoApprovedShareAfter, 12 / 18);
    assert.match(s.reason, /2 of the last 10/);
  });

  it('counts a rejection as a bad outcome', () => {
    const r = run([...base, order(3, 600, 'declined'), order(2, 9000, 'rejected')], { autoApproveLimitEur: 500 });
    assert.equal(r.suggestions[0].kind, 'lower_auto_limit');
  });

  it('does not lower for one decline, or when the two declines are older than the last ten', () => {
    assert.deepEqual(run([...base, declines[0]], { autoApproveLimitEur: 500 }).suggestions.filter((s) => s.kind === 'lower_auto_limit'), []);
    const old = [order(50, 600, 'declined'), order(49, 700, 'declined')];
    const later = Array.from({ length: 12 }, (_, i) => order(40 - i, 100 + i * 10, 'approved'));
    assert.equal(run([...old, ...later], { autoApproveLimitEur: 500 }).suggestions.filter((s) => s.kind === 'lower_auto_limit').length, 0);
  });

  it('never goes below the floor', () => {
    const tiny = Array.from({ length: 16 }, (_, i) => order(40 - i, 10 + i, 'approved'));
    assert.equal(run([...tiny, ...declines], { autoApproveLimitEur: 500 }).suggestions[0].to, 50);
  });

  it('suggests nothing when the limit is already at or below that level, and withholds a raise too', () => {
    const r = run([...base, ...declines], { autoApproveLimitEur: 200 });
    assert.deepEqual(r.suggestions, []);
    assert.match(r.summary.noSuggestionReason ?? '', /already at or below/);
  });
});

describe('suggestion id', () => {
  const ev = { orders: 20, approved: 20, declined: 0 };
  it('is deterministic and changes with every input', () => {
    const id = suggestionId('m1', 'autoApproveLimitEur', 400, ev);
    assert.equal(id, suggestionId('m1', 'autoApproveLimitEur', 400, { ...ev }));
    assert.match(id, /^[0-9a-f]{16}$/);
    for (const other of [
      suggestionId('m2', 'autoApproveLimitEur', 400, ev),
      suggestionId('m1', 'maxOrderEur', 400, ev),
      suggestionId('m1', 'autoApproveLimitEur', 300, ev),
      suggestionId('m1', 'autoApproveLimitEur', 400, { ...ev, orders: 21 }),
      suggestionId('m1', 'autoApproveLimitEur', 400, { ...ev, declined: 1 }),
    ]) {
      assert.notEqual(other, id);
    }
  });

  it('is the same for the same history and changes when the history does', () => {
    assert.equal(run(approved(20)).suggestions[0].id, run(approved(20)).suggestions[0].id);
    assert.notEqual(run(approved(20)).suggestions[0].id, run([...approved(20), order(1, 260, 'approved')]).suggestions[0].id);
  });
});

describe('accepting', () => {
  it('finds the current suggestion and refuses a stale id with a 409', () => {
    const [s] = run(approved(20)).suggestions;
    assert.equal(pickSuggestion([s], s.id), s);
    assert.throws(() => pickSuggestion([s], 'stale'), (e: { status?: number }) => e.status === 409);
    assert.throws(() => pickSuggestion([], s.id), (e: { status?: number }) => e.status === 409);
    // the history moved on since the person looked: the old id no longer matches
    const moved = run([...approved(20), order(1, 260, 'declined')]).suggestions;
    assert.throws(() => pickSuggestion(moved, s.id), (e: { status?: number }) => e.status === 409);
  });

  it('validates the body', () => {
    assert.deepEqual(AcceptBody.parse({ mandateId: 'm1', suggestionId: 'abc', decidedBy: ' Sari ' }), { mandateId: 'm1', suggestionId: 'abc', decidedBy: 'Sari' });
    for (const bad of [{}, { mandateId: 'm1', suggestionId: 'abc' }, { mandateId: 'm1', suggestionId: 'abc', decidedBy: '  ' }, { mandateId: '', suggestionId: 'abc', decidedBy: 'x' }]) {
      assert.throws(() => AcceptBody.parse(bad));
    }
  });

  it('is behind the approver key', () => {
    const req = new Request('http://x/api/autonomy', { method: 'POST' });
    assert.throws(() => requireApprover(req, { APPROVER_KEY: 'k' }), (e: { status?: number }) => e.status === 401);
    assert.doesNotThrow(() => requireApprover(new Request('http://x', { headers: { authorization: 'Bearer k' } }), { APPROVER_KEY: 'k' }));
  });
});

describe('trajectory and history note', () => {
  it('gives the approved share of reviewed orders per month, oldest first', () => {
    const t = trajectory([
      { at: '2026-09-30T23:00:00.000Z', total: 1, outcome: 'approved', synthetic: true },
      { at: '2026-10-02T08:00:00.000Z', total: 1, outcome: 'approved', synthetic: true },
      { at: '2026-10-03T08:00:00.000Z', total: 1, outcome: 'declined', synthetic: true },
      { at: '2026-10-04T08:00:00.000Z', total: 1, outcome: 'auto_approved', synthetic: true },
      { at: '2026-10-05T08:00:00.000Z', total: 1, outcome: 'pending', synthetic: false },
    ]);
    assert.deepEqual(t, [
      { month: '2026-09', reviewed: 1, approved: 1, approvalRate: 1 },
      { month: '2026-10', reviewed: 2, approved: 1, approvalRate: 0.5 },
    ]);
  });

  it('labels synthetic history', () => {
    assert.match(historyNote([]), /No order history/);
    assert.match(historyNote([order(1, 1, 'approved', false)]), /real/);
    assert.match(historyNote([order(1, 1, 'approved', true)]), /^Demo history: all 1/);
    assert.match(historyNote([order(1, 1, 'approved', true), order(1, 1, 'approved', false)]), /^Demo history: 1 of 2/);
  });

  it('reports the synthetic share of the evidence', () => {
    const mixed = approved(20).map((o, i) => ({ ...o, synthetic: i % 2 === 0 }));
    const s = run(mixed).suggestions[0];
    assert.equal(s.evidence.syntheticShare, 0.5);
    assert.equal(run(mixed).summary.syntheticShare, 0.5);
  });
});
