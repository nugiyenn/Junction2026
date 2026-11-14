import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAX_REQUEST_CHARS, quantityLineCount } from '../src/lib/interpret.ts';
import { MAX_RECIPE_CHARS } from '../src/lib/recipe.ts';
import { checkRecipeText, checkRequestText } from '../src/lib/text-check.ts';

const LIST = '20 kg mozzarella\n10 kg tomato sauce\n5 kg onion';

describe('checkRequestText', () => {
  it('says nothing for an empty box and for a normal request', () => {
    assert.equal(checkRequestText('').level, 'ok');
    assert.equal(checkRequestText('   ').level, 'ok');
    assert.equal(checkRequestText('I need 1,000 litres of lactose-free milk by Monday.').level, 'ok');
    assert.equal(checkRequestText('100 L lactose-free milk by Monday').level, 'ok');
  });

  it('blocks a text that is too short to read', () => {
    const c = checkRequestText('hi');
    assert.equal(c.level, 'block');
    assert.match(c.message ?? '', /little more/);
  });

  it('blocks a text over the limit the server enforces, and says by how much', () => {
    assert.equal(checkRequestText('1'.repeat(MAX_REQUEST_CHARS)).level, 'ok');
    const c = checkRequestText('1'.repeat(MAX_REQUEST_CHARS + 1));
    assert.equal(c.level, 'block');
    assert.match(c.message ?? '', /Too long: 4,001 of 4,000/);
  });

  it('blocks a recipe or list and points to Recipe order, exactly when the server would refuse it', () => {
    const c = checkRequestText(LIST);
    assert.equal(c.level, 'block');
    assert.equal(c.link?.href, '/recipe');
    assert.match(c.message ?? '', /3 products/);
    // The server refuses at three quantity lines; two are fine.
    assert.equal(quantityLineCount(LIST) >= 3, true);
    assert.equal(checkRequestText('20 kg mozzarella\n10 kg tomato sauce').level, 'ok');
  });

  it('hints, but does not block, when no amount is written', () => {
    const c = checkRequestText('I need some milk by Monday please');
    assert.equal(c.level, 'hint');
    assert.match(c.message ?? '', /No amount found/);
  });
});

describe('checkRecipeText', () => {
  it('says nothing for an empty box', () => {
    assert.equal(checkRecipeText('').level, 'ok');
  });

  it('counts the lines it reads, as information', () => {
    const c = checkRecipeText(LIST);
    assert.equal(c.level, 'info');
    assert.equal(c.message, '3 lines found.');
    assert.equal(checkRecipeText('20 kg mozzarella').message, '1 line found.');
  });

  it('names what it could not read', () => {
    const c = checkRecipeText(`Ainekset\n${LIST}`);
    assert.equal(c.level, 'info');
    assert.match(c.message ?? '', /3 lines found\. Not read: "Ainekset"\./);
  });

  it('hints, but does not block, a plain sentence (a model can read it)', () => {
    const c = checkRecipeText('I need 20 kg of mozzarella and 10 kg of tomato sauce for friday');
    assert.equal(c.level, 'hint');
    assert.match(c.message ?? '', /plain sentence/);
  });

  it('blocks more lines than an order may hold, and a text over the limit', () => {
    const many = Array.from({ length: 41 }, (_, i) => `${i + 1} kg product${i}`).join('\n');
    const c = checkRecipeText(many);
    assert.equal(c.level, 'block');
    assert.match(c.message ?? '', /41 lines\. An order covers at most 40/);
    assert.equal(checkRecipeText('x'.repeat(MAX_RECIPE_CHARS + 1)).level, 'block');
  });
});
