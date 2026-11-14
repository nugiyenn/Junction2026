import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { withTimeout } from '../src/lib/deadline.ts';

const wait = (ms: number, value = 'done') => new Promise<string>((r) => setTimeout(() => r(value), ms));

describe('withTimeout', () => {
  it('returns the result when the work is faster than the clock', async () => {
    assert.equal(await withTimeout(wait(5), 200, () => new Error('late')), 'done');
  });
  it('rejects with the given error when the clock wins', async () => {
    await assert.rejects(withTimeout(wait(200), 10, () => new Error('too slow')), /too slow/);
  });
  it('passes the work\'s own error through', async () => {
    await assert.rejects(withTimeout(Promise.reject(new Error('boom')), 200, () => new Error('late')), /boom/);
  });
  it('does not leak an unhandled rejection from abandoned work', async () => {
    let unhandled = false;
    const onUnhandled = () => { unhandled = true; };
    process.once('unhandledRejection', onUnhandled);
    const slowFailure = new Promise<string>((_, reject) => setTimeout(() => reject(new Error('later')), 30));
    await assert.rejects(withTimeout(slowFailure, 5, () => new Error('timeout')), /timeout/);
    await wait(60);
    process.off('unhandledRejection', onUnhandled);
    assert.equal(unhandled, false);
  });
});
