import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compareWithCatalog, evidenceAppears, normalize, pageMatchesProduct } from '../src/lib/evidence.ts';
import type { VerifiedStatement } from '../src/types/index.ts';

const PAGE = `# Valio Eila® milk drink 1 l lactose-free

**Allergens:** Contains milk. May contain traces of   tree nuts.

GTIN 6408430000241`;

describe('evidenceAppears', () => {
  it('finds a passage despite markdown, case and whitespace differences', () => {
    assert.ok(evidenceAppears('Contains milk. May contain traces of tree nuts.', PAGE));
    assert.ok(evidenceAppears('ALLERGENS: contains milk', PAGE));
  });
  it('rejects a passage that is not on the page', () => {
    assert.equal(evidenceAppears('Contains peanuts and sesame seeds.', PAGE), false);
  });
  it('rejects a quote too short to mean anything', () => {
    assert.equal(evidenceAppears('milk', PAGE), false);
  });
  it('normalises typographic quotes', () => {
    assert.equal(normalize('It’s “fresh”'), 'it\'s "fresh"');
  });
});

describe('pageMatchesProduct', () => {
  const product = { nameEn: 'Valio Eila® milk drink 1 l lactose free', nameFi: 'Valio Eila maitojuoma', gtin: '6408430000241' };
  it('matches on the GTIN', () => {
    assert.ok(pageMatchesProduct('Barcode 6408430000241', { ...product, nameEn: 'Something else entirely' }));
  });
  it('matches on most of the name\'s distinctive words', () => {
    assert.ok(pageMatchesProduct('Valio Eila milk drink, lactose free, 1 l bottle', { ...product, gtin: null }));
  });
  it('rejects a page about a different product', () => {
    assert.equal(pageMatchesProduct('Arla oat drink with calcium. Allergens: none.', { ...product, gtin: null }), false);
  });
});

describe('compareWithCatalog', () => {
  const s = (allergen: string, stance: VerifiedStatement['stance']): VerifiedStatement => ({
    topic: 'allergen',
    stance,
    allergen,
    text: '',
    evidence: '',
    sourceUrl: 'https://shop.example/p',
  });
  const catalog = (over = {}) => ({ allergensContain: ['AM'], allergensMayContain: [], allergensFreeFrom: ['AN'], ...over });

  it('has nothing to report when page and catalog agree', () => {
    assert.deepEqual(compareWithCatalog([s('AM', 'contains'), s('AN', 'free_from')], catalog()), []);
  });
  it('flags a page that says contains where the catalog says free from', () => {
    const out = compareWithCatalog([s('AN', 'contains')], catalog());
    assert.equal(out.length, 1);
    assert.match(out[0], /contains tree nuts; the catalog is free from tree nuts/);
    assert.match(out[0], /shop\.example/);
  });
  it('flags a page that says free from where the catalog says contains', () => {
    assert.equal(compareWithCatalog([s('AM', 'free_from')], catalog()).length, 1);
  });
  it('flags an allergen the catalog does not list at all', () => {
    const out = compareWithCatalog([s('AP', 'contains')], catalog());
    assert.match(out[0], /has no entry for peanuts/);
  });
  it('treats a catalog "contains" as consistent with a page "may contain"', () => {
    assert.deepEqual(compareWithCatalog([s('AM', 'may_contain')], catalog()), []);
  });
  it('flags a catalog "may contain" that the page upgrades to "contains"', () => {
    assert.equal(compareWithCatalog([s('AN', 'contains')], catalog({ allergensMayContain: ['AN'], allergensFreeFrom: [] })).length, 1);
  });
  it('ignores non-allergen statements and de-duplicates', () => {
    const label: VerifiedStatement = { topic: 'label', stance: null, allergen: null, text: 'organic', evidence: '', sourceUrl: 'x' };
    assert.deepEqual(compareWithCatalog([label], catalog()), []);
    assert.equal(compareWithCatalog([s('AP', 'contains'), s('AP', 'contains')], catalog()).length, 1);
  });
});
