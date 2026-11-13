import { createHash } from 'node:crypto';

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

/** JSON with object keys sorted, so the same content always gives the same text. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function eventHash(prevHash: string | null, event: ChainEvent): string {
  const body = canonicalJson({
    at: event.at,
    actor: event.actor,
    action: event.action,
    mandateId: event.mandateId,
    quoteId: event.quoteId,
    orderId: event.orderId,
    summary: event.summary,
    data: event.data,
  });
  return createHash('sha256').update(`${prevHash ?? 'GENESIS'}|${body}`).digest('hex');
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
