import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canonicalJson, eventHash, verifyChain, type ChainEvent, type ChainRow } from '../src/lib/chain.ts';

const event = (n: number, over: Partial<ChainEvent> = {}): ChainEvent => ({
  at: `2026-11-13T20:0${n}:00.000Z`,
  actor: 'agent',
  action: 'quote_issued',
  mandateId: 'demo-hotel',
  quoteId: null,
  orderId: null,
  summary: `event ${n}`,
  data: { n, nested: { b: 2, a: 1 } },
  ...over,
});

/** Builds a valid chain of n events, the way the database writes it. */
function chain(n: number): ChainRow[] {
  const rows: ChainRow[] = [];
  let prev: string | null = null;
  for (let i = 1; i <= n; i++) {
    const e = event(i);
    const hash = eventHash(prev, e);
    rows.push({ ...e, id: String(i), prevHash: prev, hash });
    prev = hash;
  }
  return rows;
}

describe('canonicalJson', () => {
  it('gives the same text whatever the key order', () => {
    assert.equal(canonicalJson({ b: 1, a: { d: 1, c: 2 } }), canonicalJson({ a: { c: 2, d: 1 }, b: 1 }));
  });
  it('ignores undefined values, like JSON does', () => {
    assert.equal(canonicalJson({ a: 1, b: undefined }), canonicalJson({ a: 1 }));
  });
  it('keeps array order', () => {
    assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
  });
});

describe('verifyChain', () => {
  it('accepts an intact chain and reports its head', () => {
    const rows = chain(4);
    const status = verifyChain(rows);
    assert.equal(status.valid, true);
    assert.equal(status.checked, 4);
    assert.equal(status.head, rows[3].hash);
  });

  it('accepts an empty chain', () => {
    assert.deepEqual(verifyChain([]), { valid: true, checked: 0, brokenAt: null, reason: null, head: null });
  });

  it('detects an edited summary and names the event', () => {
    const rows = chain(4);
    rows[1] = { ...rows[1], summary: 'Order approved by someone else' };
    const status = verifyChain(rows);
    assert.equal(status.valid, false);
    assert.equal(status.brokenAt, '2');
    assert.match(status.reason!, /content was changed/);
  });

  it('detects edited data nested inside an event', () => {
    const rows = chain(3);
    rows[2] = { ...rows[2], data: { n: 3, nested: { b: 2, a: 99 } } };
    assert.equal(verifyChain(rows).brokenAt, '3');
  });

  it('detects a removed event in the middle', () => {
    const rows = chain(4);
    rows.splice(1, 1);
    const status = verifyChain(rows);
    assert.equal(status.valid, false);
    assert.equal(status.brokenAt, '3');
    assert.match(status.reason!, /removed, added or reordered/);
  });

  it('detects reordered events', () => {
    const rows = chain(3);
    [rows[0], rows[1]] = [rows[1], rows[0]];
    assert.equal(verifyChain(rows).valid, false);
  });

  it('detects an event with no hash', () => {
    const rows = chain(2);
    rows[1] = { ...rows[1], hash: null };
    assert.match(verifyChain(rows).reason!, /no hash/);
  });

  it('does not depend on the order of keys in data', () => {
    const rows = chain(2);
    rows[0] = { ...rows[0], data: { nested: { a: 1, b: 2 }, n: 1 } };
    assert.equal(verifyChain(rows).valid, true);
  });

  it('cannot notice the newest events being cut off, which is why the head hash is published', () => {
    assert.equal(verifyChain(chain(4).slice(0, 3)).valid, true);
  });
});
