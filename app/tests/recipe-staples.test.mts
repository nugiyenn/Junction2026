import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isNotOrdered } from '../src/lib/recipe-score.ts';

describe('isNotOrdered (water and ice)', () => {
  it('recognises water and ice in Finnish and English, with state words', () => {
    for (const name of ['kylmää vettä', 'vesi', 'water', 'cold water', 'hanavesi', 'jäätä', 'ice', 'lämmintä vettä']) {
      assert.equal(isNotOrdered(name), true, name);
    }
  });

  it('does not touch products that merely contain the word', () => {
    for (const name of ['vesimeloni', 'sparkling water', 'kivennäisvesi', 'water chestnuts', 'ice cream', 'jäätelö', 'kookosvesi', 'sokeria']) {
      assert.equal(isNotOrdered(name), false, name);
    }
  });

  it('an empty or numeric-only name is not "not ordered"', () => {
    assert.equal(isNotOrdered(''), false);
    assert.equal(isNotOrdered('12'), false);
  });
});
