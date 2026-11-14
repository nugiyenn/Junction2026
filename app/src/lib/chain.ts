import { createHash } from 'node:crypto';
import { canonicalJson, eventHashInput } from './receipt-canon.ts';

export { canonicalJson };

// Pure hash-chain logic for the audit trail. Each event's hash covers the previous event's hash and its own
// content, so changing, removing or reordering any earlier event breaks every hash after it.

export interface ChainEvent {
  /** ISO 8601, millisecond precision. */
  at: string;
  actor: string;
  action: string;
  mandateId: string | null;
  quoteId: string | null;
  orderId: string | null;
  summary: string;
  data: unknown;
}

export interface ChainRow extends ChainEvent {
  id: string;
  prevHash: string | null;
  hash: string | null;
}

export interface ChainStatus {
  valid: boolean;
  /** Events examined. */
  checked: number;
  /** The id of the first event that does not verify. */
  brokenAt: string | null;
  reason: string | null;
  /** Hash of the newest event. Publishing it elsewhere would also expose removal of the newest events. */
  head: string | null;
}

export function eventHash(prevHash: string | null, event: ChainEvent): string {
  return createHash('sha256').update(eventHashInput(prevHash, event)).digest('hex');
}

/** Rows must be in the order they were written. Stops at the first event that does not verify. */
export function verifyChain(rows: ChainRow[]): ChainStatus {
  let expectedPrev: string | null = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const broken = (reason: string): ChainStatus => ({ valid: false, checked: i + 1, brokenAt: row.id, reason, head: null });
    if (row.hash === null) return broken('this event has no hash');
    if (row.prevHash !== expectedPrev) return broken('it does not follow the event before it: an event was removed, added or reordered');
    if (eventHash(row.prevHash, row) !== row.hash) return broken('its content was changed after it was recorded');
    expectedPrev = row.hash;
  }
  return { valid: true, checked: rows.length, brokenAt: null, reason: null, head: expectedPrev };
}
