import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { exposeQuote } from '../src/lib/exposure.ts';
import { packQuantity, roundPackSize } from '../src/lib/packs.ts';
import { mapLimit } from '../src/lib/pool.ts';
import { defaultDeliveryDate, parseRecipe, slugWords } from '../src/lib/recipe.ts';
import { toRecipeProduct } from '../src/lib/recipe-product.ts';
import { compoundParts, matchStatus, orderByOrderability, prefixTerms, productWords, rankProducts, sameWord, searchQuery, sizeFit, sizesIn, slugSizes, splitCompound, stem, wordMatch } from '../src/lib/recipe-score.ts';
import type { Quote, QuoteLine } from '../src/types/index.ts';

const RECIPE = `0,323 kg
[Oddlygood® Cooking Oat tuotetta](https://www.valioaimo.fi/ammattilaistuotteet/oddlygood-cooking-oat-original/1-l-tolkki/)
0,277 kg Oddlygood® Dream Fraiche tuotetta
1,062 kg kylmää vettä
0,037 kg punaviinietikkaa
0,016 kg valkosipulimurskaa
0,139 kg tomaattipyreetä
0,021 kg kasvisliemijauhetta
0,002 kg suolaa
0,001 kg jauhettua mustapippuria
0,003 kg kuivattua rakuunaa
0,009 kg sokeria
0,021 kg kylmätärkkelystä
0,877 kg
[Valio Gold&Green® suikaleita original](https://www.valioaimo.fi/ammattilaistuotteet/valio-goldgreen-suikale-original/)
0,277 kg fenkolia
0,111 kg pakastesipulikuutioita`;

const brief = (text: string) => parseRecipe(text).lines.map((l) => `${l.amount} ${l.unit} ${l.name}`);

describe('parseRecipe: the 15-line recipe', () => {
  const { lines, skipped } = parseRecipe(RECIPE);

  it('reads all 15 lines and skips none', () => {
    assert.equal(lines.length, 15);
    assert.deepEqual(skipped, []);
  });

  it('reads the Finnish decimal comma', () => {
    assert.deepEqual(
      lines.map((l) => l.amount),
      [0.323, 0.277, 1.062, 0.037, 0.016, 0.139, 0.021, 0.002, 0.001, 0.003, 0.009, 0.021, 0.877, 0.277, 0.111]
    );
    assert.ok(lines.every((l) => l.unit === 'KG'));
  });

  it('takes the name from the next line and keeps the product link', () => {
    assert.equal(lines[0].name, 'Oddlygood Cooking Oat');
    assert.equal(lines[0].link, 'https://www.valioaimo.fi/ammattilaistuotteet/oddlygood-cooking-oat-original/1-l-tolkki/');
    assert.equal(lines[12].name, 'Valio Gold&Green suikaleita original');
    assert.equal(lines[12].link, 'https://www.valioaimo.fi/ammattilaistuotteet/valio-goldgreen-suikale-original/');
  });

  it('strips the trademark signs and trailing "tuotetta"', () => {
    assert.equal(lines[1].name, 'Oddlygood Dream Fraiche');
    assert.ok(lines.every((l) => !/[®™]|tuotetta/.test(l.name)));
    assert.equal(lines[1].link, undefined);
  });

  it('keeps plain names as written', () => {
    assert.deepEqual(
      lines.slice(2, 12).map((l) => l.name),
      ['kylmää vettä', 'punaviinietikkaa', 'valkosipulimurskaa', 'tomaattipyreetä', 'kasvisliemijauhetta', 'suolaa', 'jauhettua mustapippuria', 'kuivattua rakuunaa', 'sokeria', 'kylmätärkkelystä']
    );
  });
});

describe('parseRecipe: other shapes', () => {
  it('reads name first and comma separated lists', () => {
    assert.deepEqual(brief('mozzarella 20 kg'), ['20 KG mozzarella']);
    assert.deepEqual(brief('20 kg mozzarella, 10 kg tomato sauce, pizza dough 50 pcs'), [
      '20 KG mozzarella',
      '10 KG tomato sauce',
      '50 unit pizza dough',
    ]);
  });

  it('keeps a decimal comma inside a comma separated list', () => {
    assert.deepEqual(brief('0,5 l cream, 1,5 kg butter; 2 kg flour'), ['0.5 L cream', '1.5 KG butter', '2 KG flour']);
  });

  it('reads bullets and converts units', () => {
    const text = '- 500 g flour\n* 2 dl milk\n• 50 ml oil\n- 10 cl cream\n- 12 kpl eggs\n- 3 pc lemons\n- 6 st rolls\n- 2 L water';
    assert.deepEqual(brief(text), [
      '0.5 KG flour',
      '0.2 L milk',
      '0.05 L oil',
      '0.1 L cream',
      '12 unit eggs',
      '3 unit lemons',
      '6 unit rolls',
      '2 L water',
    ]);
  });

  it('reads a name first with a colon or dash, and a product link on one line', () => {
    assert.deepEqual(brief('mozzarella: 20 kg\ntomato sauce - 10 kg'), ['20 KG mozzarella', '10 KG tomato sauce']);
    const [line] = parseRecipe('2 kg [Valio Mozzarella](https://www.valioaimo.fi/ammattilaistuotteet/valio-mozzarella-pizza/)').lines;
    assert.equal(line.name, 'Valio Mozzarella');
    assert.equal(line.link, 'https://www.valioaimo.fi/ammattilaistuotteet/valio-mozzarella-pizza/');
  });

  it('ignores blank lines and handles Windows line endings', () => {
    assert.equal(parseRecipe('\n\n2 kg flour\r\n\r\n\r\n1 kg salt\r\n').lines.length, 2);
  });

  it('sends unreadable lines to skipped and never drops them silently', () => {
    const r = parseRecipe('2 kg flour\nthis is not an ingredient\n1 kg salt\n3 kg');
    assert.equal(r.lines.length, 2);
    assert.deepEqual(r.skipped, ['this is not an ingredient', '3 kg']);
  });

  it('skips a name without an amount', () => {
    assert.deepEqual(parseRecipe('dough, tomato sauce, mozzarella').skipped, ['dough', 'tomato sauce', 'mozzarella']);
  });

  it('gives garbage no lines', () => {
    const r = parseRecipe('asdf qwer ;;; ???');
    assert.equal(r.lines.length, 0);
    assert.ok(r.skipped.length > 0);
  });

  it('applies no multiplier: that is the caller\'s job', () => {
    assert.equal(parseRecipe('2 kg flour').lines[0].amount, 2);
  });

  it('reads the slug words of a product link', () => {
    assert.equal(slugWords('https://www.valioaimo.fi/ammattilaistuotteet/oddlygood-cooking-oat-original/1-l-tolkki/'), 'oddlygood cooking oat original');
    assert.equal(slugWords('not a url'), '');
    assert.equal(parseRecipe('1 kg\nhttps://www.valioaimo.fi/ammattilaistuotteet/valio-mozzarella-pizza/').lines[0].name, 'valio mozzarella pizza');
  });
});

describe('defaultDeliveryDate', () => {
  it('is the first weekday at least three days ahead', () => {
    assert.equal(defaultDeliveryDate('2026-11-14'), '2026-11-17'); // Saturday + 3 = Tuesday
    assert.equal(defaultDeliveryDate('2026-11-16'), '2026-11-19'); // Monday + 3 = Thursday
    assert.equal(defaultDeliveryDate('2026-11-18'), '2026-11-23'); // Wednesday + 3 = Saturday -> Monday
    assert.equal(defaultDeliveryDate('2026-11-19'), '2026-11-23'); // Thursday + 3 = Sunday -> Monday
  });
});

describe('packQuantity (shared by requests and recipes)', () => {
  const eur = (value: number) => ({ value, valueWithTax: value * 1.14, validFrom: '2026-01-01', validTo: '2026-12-31', currency: 'EUR' });
  const price = (catalog: number, comparison: number, unit: 'KG' | 'L' = 'L') => ({
    comparisonUnit: unit,
    catalogPrice: eur(catalog),
    comparisonPrice: eur(comparison),
  });

  it('rounds the pack size to two significant figures', () => {
    assert.equal(roundPackSize(19.94), 20);
    assert.equal(roundPackSize(0.497), 0.5);
  });

  it('sizes the pack from the price and rounds the packs up', () => {
    const r = packQuantity(price(10, 2), 12, 'L', 1); // 5 L per pack
    assert.deepEqual(r, { amountPerUnit: 5, quantity: 3, reasons: [] });
  });

  it('rounds up to the lot size', () => {
    assert.equal(packQuantity(price(10, 2), 12, 'L', 4).quantity, 4);
    assert.equal(packQuantity(price(10, 2), 25, 'L', 4).quantity, 8);
  });

  it('counts pieces one for one', () => {
    assert.deepEqual(packQuantity(undefined, 50, 'unit', 1), { amountPerUnit: 1, quantity: 50, reasons: [] });
    assert.equal(packQuantity(undefined, 50, 'unit', 10).quantity, 50);
    assert.equal(packQuantity(undefined, 7.2, 'unit', 1).quantity, 8);
  });

  it('gives no size when the price is in another unit, missing or zero', () => {
    const wrong = packQuantity(price(10, 2, 'KG'), 12, 'L', 1);
    assert.equal(wrong.quantity, null);
    assert.match(wrong.reasons[0], /Priced per KG, not per L/);
    assert.match(packQuantity(undefined, 1, 'KG', 1).reasons[0], /unknown unit/);
    assert.match(packQuantity({ comparisonUnit: 'KG', catalogPrice: null, comparisonPrice: null }, 1, 'KG', 1).reasons[0], /No price per litre or kilo/);
    assert.equal(packQuantity(price(10, 0), 1, 'L', 1).quantity, null);
  });

  it('gives one pack for a tiny amount', () => {
    assert.equal(packQuantity(price(10, 10), 0.002, 'L', 1).quantity, 1);
  });
});

describe('mapLimit', () => {
  it('never runs more than the limit at once and keeps the order', async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8, 9], 4, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return n * 2;
    });
    assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14, 16, 18]);
    assert.ok(peak <= 4);
    assert.ok(peak > 1);
  });

  it('handles an empty list', async () => {
    assert.deepEqual(await mapLimit([], 4, async (x) => x), []);
  });
});

const p = (id: string, nameFi: string, nameEn: string | null = null, similarity = 0.02) => ({ id, nameFi, nameEn, brand: null, similarity });

describe('matching words', () => {

  it('treats Finnish endings and compounds as the same word', () => {
    assert.ok(sameWord('tomaattipyreetä', 'tomaattipyree'));
    assert.ok(sameWord('suolaa', 'suola'));
    assert.ok(!sameWord('vettä', 'vesi'));
    assert.ok(!sameWord('oat', 'ohra'));
  });

  it('searches with the link words added to the name', () => {
    assert.equal(
      searchQuery({ name: 'Oddlygood Cooking Oat', link: 'https://www.valioaimo.fi/ammattilaistuotteet/oddlygood-cooking-oat-original/1-l-tolkki/' }),
      'oddlygood cooking oat original'
    );
    assert.equal(searchQuery({ name: 'kylmää vettä' }), 'kylmää vettä kylmä');
    assert.equal(searchQuery({ name: 'sokeria' }), 'sokeria sokeri');
    assert.equal(searchQuery({ name: 'mozzarella' }), 'mozzarella');
  });

  it('stems common Finnish endings and leaves short and English words alone', () => {
    assert.equal(stem('suolaa'), 'suola');
    assert.equal(stem('sokeria'), 'sokeri');
    assert.equal(stem('tomaattipyreetä'), 'tomaattipyree');
    assert.equal(stem('kylmätärkkelystä'), 'kylmätärkkelys');
    assert.equal(stem('pakastesipulikuutioita'), 'pakastesipulikuutio');
    assert.equal(stem('suikaleita'), 'suikale');
    assert.equal(stem('pasta'), 'pasta');
    assert.equal(stem('mozzarella'), 'mozzarella');
  });

  it('scores a compound by how much of it a product word covers', () => {
    assert.equal(wordMatch('mozzarella', 'mozzarellaviipale'), 1);
    assert.equal(wordMatch('suolaa', 'suolaheinä'), 0);
    assert.equal(wordMatch('valkosipulimurskaa', 'valkosipuli'), 0.5);
    assert.equal(wordMatch('goldgreen', 'gold'), 0);
  });

  it('drops what a negator takes away: "no added sugar" is not a sugar product', () => {
    assert.deepEqual(productWords('Kymppi mämmi 550 g pakaste, ei lisättyä sokeria'), ['kymppi', 'mämmi', 'pakaste']);
    assert.deepEqual(productWords('Felix less salt and sugar ketchup'), ['felix', 'ketchup']);
    assert.deepEqual(productWords('Dansukker Caster Sugar 1kg'), ['dansukker', 'caster', 'sugar']);
  });

  it('does not take a product that only mentions the word in a long text', () => {
    const [top] = rankProducts({ name: 'kylmää vettä' }, [
      p('c', 'Suma Multi Free D2 5l Yleispuhdistusaine vettä sietäville pinnoille, soveltuu myös astioiden liotukseen ja pesuun', 'Suma Multi FreeD2 5l All purpose cleaner'),
    ]);
    assert.equal(matchStatus(top.fit, top.product.similarity, false, top.precision), 'not_found');
  });

  it('reads "Gold&Green" as the one word of the product link', () => {
    const [top] = rankProducts(
      { name: 'Valio Gold&Green suikaleita original', link: 'https://www.valioaimo.fi/ammattilaistuotteet/valio-goldgreen-suikale-original/' },
      [p('g', 'Gold&Green® Mureat suikaleet 240 g, Original', 'Gold&Green® Tender strips 240 g, Original')]
    );
    assert.ok(top.fit >= 0.75);
  });

  it('ranks the product that carries the words first', () => {
    const ranked = rankProducts({ name: 'tomaattipyreetä' }, [
      p('a', 'Tomaattikastike pizza', null, 0.03),
      p('b', 'Tomaattipyree 5 kg', null, 0.02),
    ]);
    assert.equal(ranked[0].product.id, 'b');
    assert.equal(ranked[0].fit, 1);
  });

  it('uses the product link as the strongest hint', () => {
    const ranked = rankProducts(
      { name: 'Valio Gold&Green suikaleita original', link: 'https://www.valioaimo.fi/ammattilaistuotteet/valio-goldgreen-suikale-original/' },
      [p('x', 'Valio Gold&Green suikale original 1 kg', 'Valio Gold&Green strips original'), p('y', 'Valio suikale kasvis', null, 0.03)]
    );
    assert.equal(ranked[0].product.id, 'x');
    assert.equal(matchStatus(ranked[0].fit, 0.02, true), 'matched');
  });

  it('ignores cold and warm: water is not a product named "kylmää"', () => {
    const [top] = rankProducts({ name: 'kylmää vettä' }, [p('k', 'Kylmäsavulohi viipale', null, 0.02)]);
    assert.equal(matchStatus(top.fit, top.product.similarity, false), 'not_found');
  });

  it('flags a partial fit and trusts only a strong search score when no word matches', () => {
    assert.equal(matchStatus(1, 0.01, false), 'matched');
    assert.equal(matchStatus(0.5, 0.01, false), 'weak');
    assert.equal(matchStatus(0, 0.01, false), 'not_found');
    assert.equal(matchStatus(0, 0.03, false), 'weak');
  });
});

describe('what a recipe line may show', () => {
  const quoteLine: QuoteLine = {
    productId: '123',
    name: 'Valio Mozzarella 2 kg',
    quantity: 60,
    salesUnit: 'KI',
    unitPrice: 12.5,
    unitPriceWithTax: 14.25,
    comparisonPrice: 6.25,
    comparisonUnit: 'KG',
    lineTotal: 125,
    lineTotalWithTax: 142.5,
    availableAmount: 51,
    availableDate: '2026-11-17',
    closingTime: null,
    logisticModel: 'Stock',
    fulfillable: false,
    issues: ['Only 51 KI available.'],
    substitutes: [],
    internal: { listPrice: 19.99, discountPct: 37.47, netPriceFound: true, availableAmount: 51, vendorName: 'Secret Supplier Oy', category: 'INTERNAL-CAT' },
  };
  const product = { id: '123', brand: 'Valio', gtin: '6410000000001' };
  const pack = { amountPerUnit: 2, quantity: 60, reasons: [] };

  it('carries no list price, discount, supplier, category or exact stock', () => {
    const json = JSON.stringify(toRecipeProduct(product, quoteLine, pack, 'KG'));
    for (const secret of ['listPrice', 'discountPct', 'vendorName', 'Secret Supplier', 'INTERNAL-CAT', 'category', 'availableAmount', '19.99', '37.47', '"51"', ' 51 ']) {
      assert.ok(!json.includes(secret), `leaked ${secret}: ${json}`);
    }
    assert.ok(!/\b51\b/.test(json), json);
  });

  it('keeps what a buyer sees in a quote: name, packs, price, total and a stock level', () => {
    const p = toRecipeProduct(product, quoteLine, pack, 'KG');
    assert.deepEqual(
      { name: p.name, quantity: p.quantity, packSize: p.packSize, packUnit: p.packUnit, unitPrice: p.unitPrice, lineTotal: p.lineTotal, fulfillable: p.fulfillable },
      { name: 'Valio Mozzarella 2 kg', quantity: 60, packSize: 2, packUnit: 'KG', unitPrice: 12.5, lineTotal: 125, fulfillable: false }
    );
    assert.deepEqual(p.issues, ['Not enough stock for the full quantity.']);
    assert.equal(p.stock.canFill, false);
  });

  it('is a subset of what exposeQuote already shows a buyer', () => {
    const quote = { id: 'q', mandateId: 'm', deliveryDate: '2026-11-17', currency: 'EUR', lines: [quoteLine], total: 125, totalWithTax: 142.5, fulfillable: false, createdAt: '', expiresAt: '', signature: null } as Quote;
    const exposed = exposeQuote(quote).lines[0];
    const p = toRecipeProduct(product, quoteLine, pack, 'KG');
    assert.equal(p.lineTotal, exposed.lineTotal);
    assert.equal(p.unitPrice, exposed.unitPrice);
    assert.deepEqual(p.stock, exposed.stock);
  });

  it('reports a missing price without a total', () => {
    const none = { ...quoteLine, unitPrice: null, lineTotal: null, issues: ['No price available.'] };
    const p = toRecipeProduct(product, none, { amountPerUnit: null, quantity: null, reasons: ['Priced per unknown unit, not per KG.'] }, 'KG');
    assert.equal(p.quantity, null);
    assert.equal(p.lineTotal, null);
    assert.equal(p.fulfillable, false);
    assert.equal(p.packUnit, null);
    assert.deepEqual(p.issues, ['Valio has no price per kilo or litre for this product, so the packs cannot be worked out.']);
  });
});

describe('parseRecipe: a wrong line is worse than none', () => {
  it('does not turn a sentence with several amounts into one line', () => {
    const r = parseRecipe('2 packs of mozzarella and 3 buckets of cream cheese');
    assert.deepEqual(r.lines, []);
    assert.deepEqual(r.skipped, ['2 packs of mozzarella and 3 buckets of cream cheese']);
  });

  it('leaves a prose request unread', () => {
    const r = parseRecipe('I need 20 kg of mozzarella and 10 kg of tomato sauce for friday');
    assert.deepEqual(r.lines, []);
    assert.equal(r.skipped.length, 1);
  });

  it('skips a line that names two products with amounts, in either order or language', () => {
    assert.deepEqual(parseRecipe('20 kg of mozzarella and 10 kg of tomato sauce').lines, []);
    assert.deepEqual(parseRecipe('20 kg mozzarellaa ja 10 kg tomaattikastiketta').lines, []);
    assert.deepEqual(parseRecipe('mozzarella and tomato 20 kg').lines, []);
    assert.deepEqual(parseRecipe('2 mozzarella and 3 cream cheese').lines, []);
  });

  it('still reads names that merely contain a number or an ampersand', () => {
    assert.deepEqual(brief('0,277 kg Oddlygood Cooking Oat 1 l'), ['0.277 KG Oddlygood Cooking Oat 1 l']);
    assert.deepEqual(brief('2 kg Gold&Green strips'), ['2 KG Gold&Green strips']);
    assert.deepEqual(brief('20 kg ham and cheese pizza topping'), ['20 KG ham and cheese pizza topping']);
  });
});

/** A small stand-in for the catalog's own word list. */
const VOCAB = new Set(['kasvisliemi', 'jauhe', 'tärkkelys', 'kylmäsakeutuva', 'pakaste', 'sipuli', 'kuutiot', 'tomaattipyree', 'oscar', 'valio', 'viola', 'knorr']);

describe('Finnish compounds', () => {
  it('splits a compound into the catalog words it is made of', () => {
    assert.deepEqual(splitCompound('kasvisliemijauhe', VOCAB), ['kasvisliemi', 'jauhe']);
    assert.deepEqual(splitCompound('kylmätärkkelys', VOCAB), ['kylmä', 'tärkkelys']);
    assert.deepEqual(splitCompound('pakastesipulikuutio', VOCAB), ['pakaste', 'sipuli', 'kuutio']);
  });

  it('does not split a word the catalog knows, or one it knows no part of', () => {
    assert.equal(splitCompound('tomaattipyree', VOCAB), null);
    assert.equal(splitCompound('mozzarellajuusto', VOCAB), null);
    assert.equal(splitCompound('suola', VOCAB), null);
  });

  it('stems the partitive "-tta"', () => {
    assert.equal(stem('kasvisliemijauhetta'), 'kasvisliemijauhe');
    assert.equal(stem('kylmätärkkelystä'), 'kylmätärkkelys');
  });

  it('searches with prefixes of the stem and of every part', () => {
    assert.deepEqual(prefixTerms({ name: 'kasvisliemijauhetta' }, VOCAB).sort(), ['jauhe', 'kasvisliemi', 'kasvisliemijauhe']);
    assert.deepEqual(prefixTerms({ name: 'sokeria' }), ['sokeri']);
    // the descriptor "kylmä" is no reason to look for cold things
    assert.ok(!prefixTerms({ name: 'kylmätärkkelystä' }, VOCAB).includes('kylmä'));
    assert.ok(prefixTerms({ name: 'kylmätärkkelystä' }, VOCAB).includes('tärkkelys'));
    assert.deepEqual([...compoundParts({ name: 'kasvisliemijauhetta' }, VOCAB).values()], [['kasvisliemi', 'jauhe']]);
  });

  it('finds a compound among the separate words of a product, and not among unrelated ones', () => {
    const good = rankProducts({ name: 'kasvisliemijauhetta' }, [p('o', 'OSCAR® Kasvisliemi jauhe Vähäsuolainen 4 kg ämpäri', 'OSCAR® Vegetable Bouillon granulate Low Salt 4 kg')], VOCAB);
    assert.ok(good[0].fit >= 0.99, String(good[0].fit));
    assert.equal(matchStatus(good[0].fit, good[0].product.similarity, false, good[0].precision), 'matched');
    const bad = rankProducts({ name: 'kasvisliemijauhetta' }, [p('v', 'Puljonki® Vasikkaliemi 1 l tetra', 'Puljonki® Veal Bouillon 1 l tetra')], VOCAB);
    assert.equal(matchStatus(bad[0].fit, bad[0].product.similarity, false, bad[0].precision), 'not_found');
    const cold = rankProducts({ name: 'kylmätärkkelystä' }, [p('c', 'Promix kylmäsakeutuva tärkkelys 1kg', 'Promix Coldstarch 1kg')], VOCAB);
    assert.equal(matchStatus(cold[0].fit, cold[0].product.similarity, false, cold[0].precision), 'matched');
  });

  it('does not take a different word for an inflected one', () => {
    assert.equal(wordMatch('viola', 'violet'), 0);
    assert.equal(wordMatch('pehmeää', 'pehmea'), 1);
    assert.equal(wordMatch('tomaatit', 'tomaatti'), 0.9);
  });
});

describe('what the line says about size, lactose and portion packs', () => {
  const quark = { name: 'Valio pehmeää maitorahkaa 5kg', link: 'https://www.valioaimo.fi/ammattilaistuotteet/valio-pehmea-maitorahka-sanko-2/' };
  const small = p('s', 'Valio pehmeä maitorahka 200 g laktoositon', 'Valio smooth quark 200 g lactose free', 0.03);
  const bucket = p('b', 'Valio pehmeä maitorahka 5 kg laktoositon', 'Valio smooth quark 5 kg lactose free', 0.02);
  const plain = p('n', 'Valio pehmeä maitorahka 5 kg', 'Valio smooth quark 5 kg', 0.02);

  it('reads sizes in the name and in the product link', () => {
    assert.deepEqual(sizesIn('Valio pehmeää maitorahkaa 5kg'), [5]);
    assert.deepEqual(sizesIn('200 g laktoositon'), [0.2]);
    assert.deepEqual(sizesIn('Pizza Dough 60x240g').map((n) => Number(n.toFixed(6))), [0.24, 14.4]);
    assert.deepEqual(sizesIn('Basic Line 5kg/1000L'), [5, 1000]);
    assert.deepEqual(slugSizes('https://www.valioaimo.fi/ammattilaistuotteet/oddlygood-cooking-oat-original/1-l-tolkki/'), [1]);
    assert.deepEqual(slugSizes(quark.link), []);
  });

  it('compares sizes', () => {
    assert.equal(sizeFit([], [5]), 'unstated');
    assert.equal(sizeFit([5], []), 'unknown');
    assert.equal(sizeFit([5], [5]), 'fits');
    assert.equal(sizeFit([5], [0.2]), 'contradicts');
    assert.equal(sizeFit([1], [1.05]), 'fits');
  });

  it('ranks the 5 kg product above the 200 g one the search liked more', () => {
    const ranked = rankProducts(quark, [small, bucket]);
    assert.equal(ranked[0].product.id, 'b');
    assert.equal(ranked[0].size, 'fits');
    assert.equal(ranked[1].size, 'contradicts');
  });

  it('never calls a product of another size "matched": it is "check this"', () => {
    const [only] = rankProducts(quark, [small]);
    assert.ok(only.fit <= 0.6);
    assert.equal(matchStatus(only.fit, only.product.similarity, true, only.precision), 'weak');
    assert.ok(only.caveats.some((c) => /pack size/.test(c)));
  });

  it('prefers a product that is not lactose free when the line does not ask for it, and the other way round', () => {
    const [first] = rankProducts(quark, [bucket, plain]);
    assert.equal(first.product.id, 'n');
    assert.ok(rankProducts(quark, [bucket])[0].caveats.some((c) => /lactose free/.test(c)));
    const asked = rankProducts({ name: 'vispikerma laktoositon' }, [p('a', 'Valio vispikerma 1 l', 'Valio whipping cream 1 l', 0.03), p('b', 'Valio vispikerma 1 l laktoositon', 'Valio whipping cream 1 l lactose free', 0.02)]);
    assert.equal(asked[0].product.id, 'b');
  });

  it('prefers plain bulk products to portion packs unless the line asks for them', () => {
    const items = [p('seg', 'Segafredo ruskea sokeri 500x5g', 'Segafredo brown sugar 500x5g', 0.03), p('dan', 'Dansukker Siro Erikoishieno Sokeri 1kg', 'Dansukker Caster Sugar 1kg', 0.015)];
    assert.equal(rankProducts({ name: 'sokeria' }, items)[0].product.id, 'dan');
    assert.equal(rankProducts({ name: 'sokeripussi 5g annos 500x5g' }, items)[0].product.id, 'seg');
  });

  it('counts a pack type in the link ("sanko") as a small plus', () => {
    const [a, b] = rankProducts({ name: 'Valio Oivariini', link: 'https://www.valioaimo.fi/ammattilaistuotteet/valio-oivariini-sanko/' }, [
      p('x', 'Valio Oivariini® 2,5 kg pussi', null, 0.02),
      p('y', 'Valio Oivariini® 2,5 kg sanko', null, 0.02),
    ]);
    assert.equal(a.product.id, 'y');
    assert.ok(a.score > b.score);
  });

  it('accepts a brand that opens the product name, however long the rest is', () => {
    const [top] = rankProducts({ name: 'Viola' }, [p('v', 'Valio Viola® kevyt e200 g maustamaton tuorejuusto laktoositon', 'Valio Viola® light e200 g natural cream cheese lactose free', 0.02)]);
    assert.equal(matchStatus(top.fit, top.product.similarity, false, top.precision), 'matched');
    const [carrot] = rankProducts({ name: 'Viola' }, [p('c', 'PORKKANA VIOLETTI HOLLANTI', 'CARROT VIOLET NL', 0.02)]);
    assert.equal(matchStatus(carrot.fit, carrot.product.similarity, false, carrot.precision), 'not_found');
  });
});

describe('orderable products come first among equally good matches', () => {
  const c = (id: string, score: number, over: Partial<{ matched: boolean; sized: boolean; deliverable: boolean }> = {}) => ({
    id,
    score,
    matched: true,
    sized: true,
    deliverable: true,
    ...over,
  });
  const order = (items: ReturnType<typeof c>[]) => orderByOrderability(items, (x) => x).map((x) => x.id);

  it('promotes a deliverable product over a slightly better match that cannot be delivered', () => {
    assert.deepEqual(order([c('best', 1.3, { deliverable: false }), c('also', 1.25)]), ['also', 'best']);
  });

  it('keeps the match order when all can be delivered, and when none can', () => {
    assert.deepEqual(order([c('a', 1.3), c('b', 1.28), c('c', 1.2)]), ['a', 'b', 'c']);
    assert.deepEqual(order([c('a', 1.3, { deliverable: false }), c('b', 1.28, { deliverable: false })]), ['a', 'b']);
  });

  it('never promotes a clearly worse match for being orderable', () => {
    assert.deepEqual(order([c('best', 1.3, { deliverable: false }), c('worse', 1.0)]), ['best', 'worse']);
  });

  it('never promotes a weaker tier ("check this") over a matched product', () => {
    assert.deepEqual(order([c('best', 1.3, { deliverable: false }), c('weak', 1.25, { matched: false })]), ['best', 'weak']);
  });

  it('puts a product with a pack size before one without, and a deliverable one before one that is short', () => {
    assert.deepEqual(order([c('unsized', 1.3, { sized: false }), c('short', 1.29, { deliverable: false }), c('ok', 1.28)]), ['ok', 'short', 'unsized']);
  });

  it('handles an empty list', () => {
    assert.deepEqual(order([]), []);
  });
});
