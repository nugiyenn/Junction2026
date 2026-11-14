import { createHash } from 'node:crypto';
import type { AutonomyMonth, AutonomyOrder, AutonomyResult, AutonomySuggestion, AutonomySummary } from '../types/index.ts';

// Earned autonomy: look at how people decided a buyer's orders and propose a new auto-approve limit. Plain deterministic
// code, no model. The server recomputes the proposal before applying it, so the suggestion `id` is a hash of its inputs.

/** How far back a decision still counts as evidence. */
export const WINDOW_DAYS = 90;
/** Fewer reviewed orders than this (in the window, and up to a candidate limit) is too little to suggest anything. */
export const MIN_REVIEWED = 12;
/** RAISE needs at least this share of the reviewed orders approved. With no declines allowed it is a second guard. */
export const MIN_APPROVAL_RATE = 0.95;
/** RAISE tries these multiples of the current limit, highest first. */
export const RAISE_STEPS = [1.25, 1.5, 2];
/** The auto-approve limit never goes above this share of the maximum order value: big orders always see a person. */
export const MAX_SHARE_OF_MAX_ORDER = 0.5;
/** LOWER looks at this many of the latest decided orders... */
export const LOWER_LAST_N = 10;
/** ...and fires when at least this many were declined by a person or rejected by the mandate. */
export const LOWER_MIN_BAD = 2;
/** LOWER never suggests a limit below this (EUR): tightening further would stop autonomy altogether. */
export const LOWER_FLOOR_EUR = 50;
/** Limits are whole multiples of this (EUR), rounded down. */
const ROUND_EUR = 5;

const DAY_MS = 86_400_000;

const isReviewed = (o: AutonomyOrder) => o.outcome === 'approved' || o.outcome === 'declined';
const isConfirmed = (o: AutonomyOrder) => o.outcome === 'approved' || o.outcome === 'auto_approved';
const roundDown = (n: number) => Math.floor(n / ROUND_EUR) * ROUND_EUR;
const share = (n: number, of: number) => (of === 0 ? 0 : n / of);
const money = (n: number) => `€${n.toLocaleString('en-GB', { maximumFractionDigits: 2 })}`;

/** Linear interpolation between closest ranks, q in 0..1, `sorted` ascending and not empty. */
function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export interface AutonomyInput {
  mandateId: string;
  /** The current auto-approve limit (EUR). */
  autoApproveLimitEur: number;
  maxOrderEur: number;
  orders: AutonomyOrder[];
  /** ISO 8601. Passed in so the result is reproducible. */
  now: string;
  /** ISO 8601. Decisions before this do not count as evidence (the limit was changed then). */
  since?: string | null;
}

/** Deterministic id of a suggestion: the same mandate, field, new value and evidence counts always give the same id. */
export function suggestionId(mandateId: string, field: string, to: number, evidence: { orders: number; approved: number; declined: number }): string {
  return createHash('sha256').update(JSON.stringify([mandateId, field, to, evidence.orders, evidence.approved, evidence.declined])).digest('hex').slice(0, 16);
}

/** Share of reviewed orders approved, per calendar month (UTC), oldest first. Uses every order given, not just the window. */
export function trajectory(orders: AutonomyOrder[]): AutonomyMonth[] {
  const months = new Map<string, { reviewed: number; approved: number }>();
  for (const o of orders.filter(isReviewed)) {
    const key = new Date(o.at).toISOString().slice(0, 7);
    const m = months.get(key) ?? { reviewed: 0, approved: 0 };
    m.reviewed++;
    if (o.outcome === 'approved') m.approved++;
    months.set(key, m);
  }
  return [...months.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([month, m]) => ({ month, ...m, approvalRate: share(m.approved, m.reviewed) }));
}

/** Share of orders (by size alone: other rules such as reliability still apply) that fit under a limit. Pending and rejected orders are left out. */
function shareUnder(orders: AutonomyOrder[], limit: number): number {
  const sized = orders.filter((o) => o.outcome !== 'pending' && o.outcome !== 'rejected');
  return share(sized.filter((o) => o.total <= limit).length, sized.length);
}

/** The suggestions for one buyer, and the numbers behind them. */
export function suggestAutonomy(input: AutonomyInput): AutonomyResult {
  const { mandateId, autoApproveLimitEur: limit, maxOrderEur } = input;
  const nowMs = Date.parse(input.now);
  const from = Math.max(nowMs - WINDOW_DAYS * DAY_MS, input.since ? Date.parse(input.since) : -Infinity);
  const window = input.orders.filter((o) => Date.parse(o.at) >= from && Date.parse(o.at) <= nowMs).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const reviewed = window.filter(isReviewed);

  const summary: AutonomySummary = {
    reviewed: reviewed.length,
    approved: reviewed.filter((o) => o.outcome === 'approved').length,
    declined: reviewed.filter((o) => o.outcome === 'declined').length,
    windowDays: WINDOW_DAYS,
    syntheticShare: share(reviewed.filter((o) => o.synthetic).length, reviewed.length),
    trajectory: trajectory(input.orders),
    noSuggestionReason: null,
  };
  const none = (reason: string): AutonomyResult => ({ suggestions: [], summary: { ...summary, noSuggestionReason: reason } });
  const make = (kind: AutonomySuggestion['kind'], to: number, reason: string, evidence: AutonomyOrder[], counts: { approved: number; declined: number }): AutonomyResult => {
    const ev = { orders: evidence.length, ...counts };
    return {
      suggestions: [
        {
          id: suggestionId(mandateId, 'autoApproveLimitEur', to, ev),
          kind,
          field: 'autoApproveLimitEur',
          from: limit,
          to,
          reason,
          evidence: { ...ev, windowDays: WINDOW_DAYS, syntheticShare: share(evidence.filter((o) => o.synthetic).length, evidence.length) },
          effect: { autoApprovedShareBefore: shareUnder(window, limit), autoApprovedShareAfter: shareUnder(window, to) },
        },
      ],
      summary,
    };
  };

  const since = input.since ? ' since the last limit change' : '';
  if (reviewed.length < MIN_REVIEWED) {
    return none(`Too little history: ${reviewed.length} reviewed ${reviewed.length === 1 ? 'order' : 'orders'} in the last ${WINDOW_DAYS} days${since}, ${MIN_REVIEWED} needed.`);
  }

  // LOWER: trust is withdrawn after declines. Of the latest decided orders (a person's yes or no, or the mandate's rejection),
  // at least LOWER_MIN_BAD went wrong: move the limit down to about the 75th percentile of what was confirmed.
  const decided = window.filter((o) => isReviewed(o) || o.outcome === 'rejected').slice(-LOWER_LAST_N);
  const bad = decided.filter((o) => o.outcome !== 'approved');
  if (bad.length >= LOWER_MIN_BAD) {
    const confirmed = window.filter(isConfirmed).map((o) => o.total).sort((a, b) => a - b);
    const to = Math.max(LOWER_FLOOR_EUR, roundDown(confirmed.length ? quantile(confirmed, 0.75) : LOWER_FLOOR_EUR));
    if (to >= limit) return none(`${bad.length} of the last ${decided.length} decided orders were declined or rejected, but the limit ${money(limit)} is already at or below the typical confirmed order.`);
    return make('lower_auto_limit', to, `${bad.length} of the last ${decided.length} decided orders were declined or rejected, so the limit moves down to ${money(to)}, about the 75th percentile of confirmed orders.`, decided, {
      approved: decided.length - bad.length,
      declined: bad.length,
    });
  }

  // RAISE: trust is earned. A step up is suggested when, among reviewed orders up to that limit, there are enough of them
  // and (almost) all were approved. The highest step that passes wins; the cap keeps big orders with a person.
  const cap = roundDown(maxOrderEur * MAX_SHARE_OF_MAX_ORDER);
  const candidates = [...new Set(RAISE_STEPS.map((s) => Math.min(roundDown(limit * s), cap)))].filter((c) => c > limit).sort((a, b) => b - a);
  if (candidates.length === 0) return none(`The limit ${money(limit)} is already at half the maximum order value (${money(cap)}).`);

  for (const c of candidates) {
    const ev = reviewed.filter((o) => o.total <= c);
    const approved = ev.filter((o) => o.outcome === 'approved').length;
    const declined = ev.length - approved;
    const inBand = ev.some((o) => o.total > limit);
    if (ev.length >= MIN_REVIEWED && declined === 0 && share(approved, ev.length) >= MIN_APPROVAL_RATE && inBand) {
      return make('raise_auto_limit', c, `A person approved all ${approved} reviewed orders up to ${money(c)} in the last ${WINDOW_DAYS} days${since}; none were declined.`, ev, { approved, declined });
    }
  }
  // Say why the smallest step did not pass.
  const lowest = candidates[candidates.length - 1];
  const ev = reviewed.filter((o) => o.total <= lowest);
  const declined = ev.filter((o) => o.outcome === 'declined').length;
  return none(
    declined > 0
      ? `Not yet: a person declined ${declined} of ${ev.length} reviewed orders up to ${money(lowest)} in the last ${WINDOW_DAYS} days${since}.`
      : `Not yet: ${ev.length} reviewed orders up to ${money(lowest)}${since}, ${MIN_REVIEWED} needed with some above ${money(limit)}.`
  );
}

/** One line on how much of the history is generated demo history. Empty history gives its own line. */
export function historyNote(orders: AutonomyOrder[]): string {
  if (orders.length === 0) return 'No order history yet.';
  const synthetic = orders.filter((o) => o.synthetic).length;
  if (synthetic === 0) return `All ${orders.length} orders in the history are real.`;
  if (synthetic === orders.length) return `Demo history: all ${orders.length} orders in the history are generated demo data, not real orders.`;
  return `Demo history: ${synthetic} of ${orders.length} orders in the history are generated demo data; ${orders.length - synthetic} are real.`;
}
