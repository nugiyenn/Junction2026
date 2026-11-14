import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HttpError } from '../src/lib/http.ts';
import { ModelLinesSchema, needsModelReading, readRecipe, UNREADABLE } from '../src/lib/recipe-read.ts';
import { parseRecipe } from '../src/lib/recipe.ts';

const SENTENCE = 'I need 20 kg of mozzarella and 10 kg of tomato sauce for friday';
const GOOD = { lines: [{ name: 'mozzarella', amount: 20, unit: 'KG' }, { name: 'tomato sauce', amount: 10, unit: 'KG' }] };

/** A reader that counts its calls and answers with `answer` (or throws it). */
function fake(answer: unknown) {
  const seen: string[] = [];
  const reader = async (text: string) => {
    seen.push(text);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { reader, seen };
}

describe('when the model is asked', () => {
  it('never when the parser read everything', () => {
    assert.equal(needsModelReading(parseRecipe('2 kg flour\n1 kg salt'), '2 kg flour\n1 kg salt'), false);
  });

  it('never for text without a digit', () => {
    assert.equal(needsModelReading(parseRecipe('asdf qwer'), 'asdf qwer'), false);
  });

  it('when the parser read nothing from text with an amount', () => {
    assert.equal(needsModelReading(parseRecipe(SENTENCE), SENTENCE), true);
  });

  it('when more is unread than read, not when most is read', () => {
    const mostlyUnread = '2 kg flour\nplease deliver 3 times\nsomething else\nand more';
    assert.equal(needsModelReading(parseRecipe(mostlyUnread), mostlyUnread), true);
    const mostlyRead = '2 kg flour\n1 kg salt\n3 kg sugar\nthank you 2';
    assert.equal(needsModelReading(parseRecipe(mostlyRead), mostlyRead), false);
  });
});

describe('readRecipe', () => {
  it('uses no model when the parser found the lines', async () => {
    const { reader, seen } = fake(GOOD);
    const r = await readRecipe('20 kg mozzarella, 10 kg tomato sauce', reader);
    assert.equal(seen.length, 0);
    assert.equal(r.usedModel, false);
    assert.equal(r.lines.length, 2);
    assert.ok(r.lines.every((l) => l.readBy === 'code'));
  });

  it('asks the model for prose and marks its lines', async () => {
    const { reader, seen } = fake(GOOD);
    const r = await readRecipe(SENTENCE, reader);
    assert.deepEqual(seen, [SENTENCE]);
    assert.equal(r.usedModel, true);
    assert.deepEqual(
      r.lines.map((l) => [l.name, l.amount, l.unit, l.readBy]),
      [['mozzarella', 20, 'KG', 'model'], ['tomato sauce', 10, 'KG', 'model']]
    );
    assert.deepEqual(r.skipped, []);
  });

  it('sends only the unread items when the parser read some', async () => {
    const { reader, seen } = fake({ lines: [{ name: 'cream cheese', amount: 3, unit: 'unit' }] });
    const text = '1 kg flour\n2 kg butter\n2 packs of mozzarella and 3 buckets of cream cheese\nsend 3 days ahead please\nand 2 more things';
    const r = await readRecipe(text, reader);
    assert.equal(seen.length, 1);
    assert.ok(!seen[0].includes('flour'));
    assert.deepEqual(r.lines.map((l) => l.readBy), ['code', 'code', 'model']);
  });

  it('gives the plain message for an answer in the wrong shape, never the validator text', async () => {
    for (const bad of [
      { lines: 'two lines' },
      { lines: [{ name: 'x', amount: -1, unit: 'KG' }] },
      { lines: [{ name: 'x', amount: 1, unit: 'tons' }] },
      { lines: Array.from({ length: 41 }, () => ({ name: 'x', amount: 1, unit: 'KG' })) },
      'not an object',
      null,
      {},
    ]) {
      const { reader } = fake(bad);
      await assert.rejects(readRecipe(SENTENCE, reader), (err: unknown) => {
        assert.ok(err instanceof HttpError);
        assert.equal(err.status, 422);
        assert.equal(err.message, UNREADABLE);
        assert.ok(!/zod|expected|invalid|\{|\[/i.test(err.message));
        return true;
      });
    }
  });

  it('gives the plain message when the model fails', async () => {
    const { reader } = fake(new Error('Gemini quota exceeded {"error":{"code":429}}'));
    await assert.rejects(readRecipe(SENTENCE, reader), (err: unknown) => err instanceof HttpError && err.message === UNREADABLE);
  });

  it('gives the plain message when the model finds no product', async () => {
    const { reader } = fake({ lines: [] });
    await assert.rejects(readRecipe(SENTENCE, reader), (err: unknown) => err instanceof HttpError && err.message === UNREADABLE);
  });

  it('keeps the parser lines when the model fails on the rest', async () => {
    const { reader } = fake(new Error('down'));
    const r = await readRecipe('1 kg flour\nfor 3 people\nplease 2 days', reader);
    assert.equal(r.modelFailed, true);
    assert.equal(r.lines.length, 1);
    assert.equal(r.skipped.length, 2);
  });

  it('works without a reader: the parser alone', async () => {
    const r = await readRecipe(SENTENCE);
    assert.equal(r.lines.length, 0);
    assert.equal(r.usedModel, false);
  });
});

describe('model output validation', () => {
  it('accepts a list of named amounts and nothing else', () => {
    assert.ok(ModelLinesSchema.safeParse(GOOD).success);
    assert.ok(ModelLinesSchema.safeParse({ lines: [] }).success);
    assert.ok(!ModelLinesSchema.safeParse({ lines: [{ name: '', amount: 1, unit: 'KG' }] }).success);
  });
});
