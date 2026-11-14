import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { approverKeyConfigured, requireApprover } from '../src/lib/auth.ts';

const req = (authorization?: string) => new Request('http://x/api', { headers: authorization ? { authorization } : {} });

describe('approver key', () => {
  it('leaves the routes open when no key is configured', () => {
    assert.equal(approverKeyConfigured({}), false);
    assert.doesNotThrow(() => requireApprover(req(), {}));
    assert.doesNotThrow(() => requireApprover(req('Bearer anything'), { APPROVER_KEY: '  ' }));
  });
  it('accepts the right key', () => {
    assert.equal(approverKeyConfigured({ APPROVER_KEY: 's3cret' }), true);
    assert.doesNotThrow(() => requireApprover(req('Bearer s3cret'), { APPROVER_KEY: 's3cret' }));
  });
  it('refuses a missing, wrong or differently shaped key with a 401 and a challenge header', () => {
    for (const header of [undefined, 'Bearer nope', 'Bearer ', 's3cret', 'Basic czNjcmV0', 'Bearer s3cret-and-more']) {
      assert.throws(
        () => requireApprover(req(header), { APPROVER_KEY: 's3cret' }),
        (err: { status?: number; headers?: Record<string, string> }) => err.status === 401 && /approver/.test(err.headers?.['WWW-Authenticate'] ?? '')
      );
    }
  });
});
