import { slugWords } from './recipe.ts';
import type { RecipeLine, RecipeMatchStatus } from '../types/index.ts';

// Pure: no database, no API calls. How well a catalog product fits a recipe line, by the words of the names. The catalog
// search finds candidates (keyword and meaning); these rules rank them and decide whether to trust the best one.

/** Words that describe the state of an ingredient, not which product it is. */
const DESCRIPTORS = new Set([
  'kylmää', 'kylmä', 'lämmintä', 'lämmin', 'kuumaa', 'kuuma', 'cold', 'warm', 'hot', 'fresh', 'tuoretta', 'tuore',
  'hienonnettua', 'chopped', 'sliced', 'of', 'and', 'with', 'the', 'ja', 'tai', 'noin', 'about', 'ml', 'tuotetta', 'tuote', 'product',
]);

/** Words about how an ingredient is prepared or kept. They narrow a product down but do not name it, so they count for less. */
const PREPARATION = new Set([
  'kuivattua', 'kuivattu', 'kuivattuja', 'jauhettua', 'jauhettu', 'jauhettuja', 'pakaste', 'pakastettua', 'pakastettu', 'pakastetta', 'tuoretta',
  'raastettua', 'raastettu', 'dried', 'ground', 'frozen', 'grated', 'minced', 'crushed', 'smoked', 'savustettua', 'luomu', 'organic',
]);
const weight = (word: string) => (PREPARATION.has(word) || DESCRIPTORS.has(word) || word.startsWith('pakaste') ? 0.3 : 1);

/**
 * Ingredients that are never ordered from a wholesaler: tap water and ice. A line whose only meaningful words are these is
 * shown as "Not ordered" and never searched or priced. The list is short on purpose and every word must be the whole word:
 * "vesimeloni" (watermelon) or "sparkling water" are ordinary lines and are searched as usual.
 */
export const NOT_ORDERED_WORDS = new Set([
  'vesi', 'vettä', 'veden', 'vedellä', 'hanavesi', 'hanavettä', 'jää', 'jäätä', 'jäitä', 'jäävesi', 'jäävettä',
  'water', 'ice', 'tap', 'tapwater',
]);

/** True when the line is only water or ice, plus state words like "cold" or "kylmää". */
export function isNotOrdered(name: string): boolean {
  const significant = (name.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => !DESCRIPTORS.has(w) && !/^\d+$/.test(w));
  return significant.length > 0 && significant.every((w) => NOT_ORDERED_WORDS.has(w));
}

/** Lowercase words of a text, three letters or more. */
export function words(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= 3 && !/^\d+$/.test(w));
}

/** Words that turn the next few words into what the product does NOT have: "ei lisättyä sokeria", "without sugar", "less salt". */
const NEGATORS = new Set(['ei', 'ilman', 'vähemmän', 'vähän', 'without', 'no', 'less', 'minus']);

/**
 * The words a product text says it is made of or about: lowercase, three letters or more, and without the words
 * a negator takes away ("ketchup, ei lisättyä sokeria" is not a sugar product).
 */
export function productWords(text: string): string[] {
  const all = (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= 2 && !/^\d/.test(w));
  const out: string[] = [];
  let skip = 0;
  for (const w of all) {
    if (NEGATORS.has(w)) {
      skip = 3;
      continue;
    }
    if (skip > 0) {
      skip--;
      continue;
    }
    if (w.length >= 3) out.push(w);
  }
  return out;
}

/** The words that identify the product: descriptors removed (kept if nothing else is left). */
export function keyWords(text: string): string[] {
  const all = [...new Set(words(text))];
  const key = all.filter((w) => !DESCRIPTORS.has(w));
  return key.length > 0 ? key : all;
}

/**
 * How much `product` word `t` is the same as the line's word `q`, 0 to 1. The same word allowing Finnish endings
 * ("tomaattipyreetä" is "tomaattipyree", "suolaa" is "suola") counts 1, and so does a long word that starts a compound
 * ("mozzarella" in "mozzarellaviipale"). A line's compound that only starts with the product's word ("valkosipulimurskaa"
 * and "valkosipuli") counts half: it is the same family, not the same thing. A short word that merely starts a longer
 * one ("suola" in "suolaheinä") counts nothing.
 */
export function wordMatch(rawQ: string, rawT: string): number {
  // Finnish vowel harmony: "pehmeää" and "pehmea" (a link address has no dots) are the same word.
  const q = plain(rawQ);
  const t = plain(rawT);
  if (q === t) return 1;
  let p = 0;
  while (p < q.length && p < t.length && q[p] === t[p]) p++;
  if (p < 4) return 0;
  const shorter = Math.min(q.length, t.length);
  // One word is the other plus an ending ("sokeria" and "sokeri").
  if (p === shorter && Math.abs(q.length - t.length) <= 3) return 1;
  if (q.length >= 7 && t.startsWith(q)) return 1;
  if (p === t.length && t.length >= 5 && t.length >= 0.4 * q.length) return 0.5;
  // A changed last letters ("tomaatit" and "tomaatti"), but not a different word ("viola" and "violet").
  if (p >= 5 && q.length - p <= 2 && t.length - p <= 2) return 0.9;
  return 0;
}

const plain = (w: string) => w.replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/å/g, 'a');

export const sameWord = (a: string, b: string) => wordMatch(a, b) === 1;

/** How well a part of a compound ("tärkkelys" of "kylmätärkkelys") is found in a product word: a word that starts with it counts half. */
function partMatch(part: string, t: string): number {
  const m = wordMatch(part, t);
  return m > 0 ? m : part.length >= 5 && t.startsWith(part) ? 0.5 : 0;
}

/**
 * Weighted share of `query` words found among `text` words (partial words count their fraction; preparation words count
 * less). A query word that is a compound (`parts`) may also be found as its parts, each in a product word of its own:
 * "kasvisliemijauhe" in "Kasvisliemi jauhe".
 */
export function coverage(query: string[], text: string[], parts: ReadonlyMap<string, string[]> = new Map()): number {
  if (query.length === 0) return 0;
  let got = 0;
  let total = 0;
  for (const q of query) {
    total += weight(q);
    let best = Math.max(0, ...text.map((t) => wordMatch(q, t)));
    const ps = parts.get(q);
    if (ps && best < 1) {
      let partGot = 0;
      let partTotal = 0;
      for (const part of ps) {
        partTotal += weight(part);
        partGot += weight(part) * Math.max(0, ...text.map((t) => partMatch(part, t)));
      }
      best = Math.max(best, partGot / partTotal);
    }
    got += weight(q) * best;
  }
  return got / total;
}

/**
 * A rough Finnish stem: the keyword search matches whole words, so "sokeria" (some sugar) does not find "Sokeri".
 * Strips the common partitive and plural endings. It may be wrong for a word it was not made for, which is why the search
 * gets the word and its stem together, never only the stem.
 */
export function stem(word: string): string {
  if (word.length < 6) return word;
  if (/(oita|öitä|eita|eitä|uita|yitä)$/.test(word)) return word.slice(0, -3);
  if (/(aa|ää|ua|yä|ia|iä)$/.test(word)) return word.slice(0, -1);
  if (word.length >= 8 && /(tta|ttä)$/.test(word)) return word.slice(0, -3);
  if (word.length >= 8 && /(ta|tä)$/.test(word)) return word.slice(0, -2);
  return word;
}

/** What to search the catalog for: the product link's words, the name, and a stem of each Finnish-looking word. */
export function searchQuery(line: Pick<RecipeLine, 'name' | 'link'>): string {
  const all = [...(line.link ? slugWords(line.link).split(' ') : []), ...line.name.split(/\s+/)].filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of [...all, ...all.map((x) => stem(x.toLowerCase()))]) {
    if (!seen.has(w.toLowerCase())) {
      seen.add(w.toLowerCase());
      out.push(w);
    }
  }
  return out.join(' ');
}

/**
 * Splits a Finnish compound into the catalog's own words: "kasvisliemijauhe" into "kasvisliemi" and "jauhe". `vocabulary` is
 * every word of the catalog. A word the catalog knows is not split. Parts are four letters or more; one part may be unknown
 * to the catalog (the rest of the word). Null when the word does not split into two parts or more.
 */
export function splitCompound(word: string, vocabulary: ReadonlySet<string>): string[] | null {
  if (word.length < 8 || vocabulary.has(word)) return null;
  // best[i][u]: fewest-cost split of word[0..i] using u (0 or 1) unknown parts.
  type Cell = { cost: number; parts: string[] } | null;
  const best: Cell[][] = Array.from({ length: word.length + 1 }, () => [null, null]);
  best[0][0] = { cost: 0, parts: [] };
  for (let i = 4; i <= word.length; i++) {
    for (let j = 0; j <= i - 4; j++) {
      const part = word.slice(j, i);
      const known = vocabulary.has(part);
      for (const used of [0, 1] as const) {
        const from = best[j][used];
        if (!from) continue;
        const target = known ? used : 1;
        if (!known && (used === 1 || (j === 0 && i === word.length))) continue;
        const cost = from.cost + (known ? 1 : 1 + 0.5 * part.length); // an unknown part costs more the more of the word it swallows
        if (!best[i][target] || cost < best[i][target]!.cost) best[i][target] = { cost, parts: [...from.parts, part] };
      }
    }
  }
  const done = [best[word.length][0], best[word.length][1]].filter((c): c is { cost: number; parts: string[] } => c !== null).sort((a, b) => a.cost - b.cost)[0];
  return done && done.parts.length >= 2 ? done.parts : null;
}

/** The compounds among a line's words, split into parts (keyed by the word as it is used for matching, its stem). */
export function compoundParts(line: Pick<RecipeLine, 'name' | 'link'>, vocabulary: ReadonlySet<string>): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const w of [...keyWords(line.name), ...(line.link ? keyWords(slugWords(line.link)) : [])]) {
    const parts = splitCompound(stem(w), vocabulary);
    if (parts) map.set(w, parts);
  }
  return map;
}

/** Terms for the keyword search as prefixes (`term:*`): the stem of each word and the parts of each compound. */
export function prefixTerms(line: Pick<RecipeLine, 'name' | 'link'>, vocabulary?: ReadonlySet<string>): string[] {
  const terms = new Set<string>();
  const wordsOfLine = [...keyWords(line.name), ...(line.link ? keyWords(slugWords(line.link)) : [])];
  for (const w of wordsOfLine) {
    const st = stem(w);
    if (st.length >= 4) terms.add(st);
  }
  if (vocabulary) for (const parts of compoundParts(line, vocabulary).values()) for (const part of parts) if (!DESCRIPTORS.has(part)) terms.add(part);
  return [...terms];
}

// --- Evidence beyond the words: the size written in the line, pack type, lactose, portion packs -----------------------

const SIZE = /(\d+(?:[.,]\d+)?)\s*(kg|g|l|dl|cl|ml)(?![\p{L}\p{N}])/giu;
const TO_BASE: Record<string, number> = { kg: 1, g: 0.001, l: 1, dl: 0.1, cl: 0.01, ml: 0.001 };

/** Pack sizes written in a text, in kilograms or litres: "5kg" is 5, "200 g" is 0.2, "20x230g" is 0.23 and 4.6. */
export function sizesIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(SIZE)) {
    const size = Number(m[1].replace(',', '.')) * TO_BASE[m[2].toLowerCase()];
    if (!(size > 0)) continue;
    out.push(size);
    const multi = /(\d+)\s*x\s*$/i.exec(text.slice(0, m.index));
    if (multi) out.push(size * Number(multi[1]));
  }
  return out;
}

/** The pack size a Valio product link names in its address: ".../1-l-tolkki/" is 1. */
export function slugSizes(link: string): number[] {
  try {
    return new URL(link).pathname
      .split('/')
      .flatMap((segment) => {
        const m = /^(\d+)-(kg|g|l|dl|cl|ml)(?:-|$)/i.exec(segment);
        return m ? [Number(m[1]) * TO_BASE[m[2].toLowerCase()]] : [];
      });
  } catch {
    return [];
  }
}

/** Whether a candidate's written sizes match the sizes the line states. */
export function sizeFit(stated: number[], candidate: number[]): 'unstated' | 'unknown' | 'fits' | 'contradicts' {
  if (stated.length === 0) return 'unstated';
  if (candidate.length === 0) return 'unknown';
  return stated.some((a) => candidate.some((b) => Math.abs(a - b) <= 0.12 * Math.max(a, b))) ? 'fits' : 'contradicts';
}

/** Pack types a product link or name may use, in Finnish and English: a line that names one wants that kind of pack. */
const PACK_GROUPS = [
  /sanko|ämpäri|bucket|pail/i,
  /tölkki|tolkki|\bcan\b/i,
  /rasia|\btub\b|\bbox\b/i,
  /purkki|\bjar\b/i,
  /pussi|\bbag\b/i,
  /pullo|bottle/i,
  /tetra|kartonki|carton/i,
];
const LACTOSE_FREE = /laktoositon|laktoton|lactose[ -]?free|lactosefree|free from lactose/i;
/** Portion and sachet packs ("500x5g", "annos", "sticks") that nobody means by a plain ingredient. */
const PORTION = /\d+\s*x\s*\d{1,2}(?:[.,]\d+)?\s*g(?![\p{L}\p{N}])|\bannos(?!ta)|portion|sachet|\btikku|\bsticks?\b/iu;

export interface Rankable {
  id: string;
  nameFi: string;
  nameEn: string | null;
  brand: string | null;
  /** Fused search score (reciprocal rank fusion): about 0.033 at best, comparable only within one search. */
  similarity: number;
}

export interface Scored<T> {
  product: T;
  /** 0-1: how many of the line's words the product name carries (for a product link: the link's words). Held at 0.6 when the product's size contradicts the line's. */
  fit: number;
  /** 0-1: how much of the product's own name the line accounts for. A long product text that merely mentions the word scores low. */
  precision: number;
  /** Ranking score: fit first, then how well the search liked it, then how little else the name says, then the evidence of size, pack type, lactose and portion packs. */
  score: number;
  /** How the product's written size compares with the size the line states. */
  size: ReturnType<typeof sizeFit>;
  /** Plain sentences on what differs from what the line says: a size, lactose-free when not asked for, a portion pack. */
  caveats: string[];
}

/** Search score that counts as "the search is sure": near the top of both the keyword and the meaning search. */
export const STRONG_SIMILARITY = 0.025;

const BEST_SIMILARITY = 2 / 60;

/**
 * Ranks search results for a line, best first. `vocabulary` (every word of the catalog) lets a Finnish compound match its parts.
 * A size written in the line ("5kg", or "1-l-tolkki" in its product link) must match the product's: one that contradicts it
 * ranks below one that fits and can never be better than "check this". A product the line does not ask for as lactose-free
 * (or does, and it is not) and a portion pack the line does not ask for rank lower.
 */
export function rankProducts<T extends Rankable>(line: Pick<RecipeLine, 'name' | 'link'>, products: T[], vocabulary?: ReadonlySet<string>): Scored<T>[] {
  const nameWords = keyWords(line.name);
  const slug = line.link ? keyWords(slugWords(line.link)) : [];
  const parts = vocabulary ? compoundParts(line, vocabulary) : new Map<string, string[]>();
  const allParts = [...parts.values()].flat();
  const statedSizes = [...sizesIn(line.name), ...(line.link ? slugSizes(line.link) : [])];
  const lineText = `${line.name} ${line.link ? slugWords(line.link) : ''}`;
  const lineLactose = LACTOSE_FREE.test(lineText);
  const linePortion = PORTION.test(lineText);
  const linePacks = PACK_GROUPS.filter((g) => g.test(lineText));
  return products
    .map((product) => {
      const names = [productWords(product.nameFi), productWords(product.nameEn ?? ''), productWords(product.brand ?? '')];
      // "Gold&Green" is the one word "goldgreen" in a product link.
      const text = names.flatMap((w) => [...w, ...w.slice(1).map((next, i) => w[i] + next)]);
      const nameFit = coverage(nameWords, text, parts);
      const slugFit = slug.length > 0 ? coverage(slug, text, parts) : 0;
      // A product link names the product exactly: trust it over the free-text name.
      let fit = slug.length > 0 ? Math.max(slugFit, 0.5 * slugFit + 0.5 * nameFit) : nameFit;
      const own = productWords(product.nameEn ?? product.nameFi);
      const ownFi = productWords(product.nameFi);
      const known = [...nameWords, ...slug, ...allParts];
      let precision = Math.max(own.length ? coverage(own, known) : 0, ownFi.length ? coverage(ownFi, known) : 0);
      // A brand or product name that opens the product's name ("Valio Viola® ...") is the product, however long the rest says.
      const opening = [...own.slice(0, 2), ...ownFi.slice(0, 2)];
      if (fit >= 0.8 && nameWords.length + slug.length <= 2 && nameWords.some((q) => opening.some((t) => wordMatch(q, t) === 1))) {
        precision = Math.max(precision, 0.5);
      }
      const sim = Math.min(product.similarity / BEST_SIMILARITY, 1);

      const productText = `${product.nameFi} ${product.nameEn ?? ''}`;
      const size = sizeFit(statedSizes, sizesIn(productText));
      let evidence = 0;
      const caveats: string[] = [];
      if (size === 'fits') evidence += 0.3;
      if (size === 'contradicts') {
        evidence -= 0.6;
        fit = Math.min(fit, 0.6);
        caveats.push('The pack size is not the one in the text.');
      }
      if (linePacks.some((g) => g.test(productText))) evidence += 0.15;
      if (LACTOSE_FREE.test(productText) !== lineLactose) {
        evidence -= 0.4;
        caveats.push(lineLactose ? 'The text asks for lactose free; this product is not marked lactose free.' : 'This product is lactose free; the text does not say so.');
      }
      const productSizes = sizesIn(productText);
      const singleServe = productSizes.length > 0 && Math.max(...productSizes) <= 0.03; // "butter 6 g": a portion, not a pack of butter
      if (!linePortion && (PORTION.test(productText) || (singleServe && !statedSizes.some((x) => x <= 0.03)))) {
        evidence -= 0.3;
        caveats.push('This is a portion pack; the text does not ask for one.');
      }
      return { product, fit, precision, size, caveats, score: fit + 0.25 * sim + 0.15 * precision + evidence };
    })
    .sort((a, b) => b.score - a.score);
}

/** The least a product's name may be about the line's words: below it the product merely mentions them. */
const MIN_PRECISION = 0.21;

/** Whether the best product found really is the line's product. */
export function matchStatus(fit: number, similarity: number, hasLink: boolean, precision = 1): Exclude<RecipeMatchStatus, 'unpriced'> {
  const strong = similarity >= STRONG_SIMILARITY;
  if (fit >= (hasLink ? 0.75 : 0.8)) {
    if (precision >= MIN_PRECISION) return 'matched';
    return strong ? 'weak' : 'not_found';
  }
  if (fit >= 0.3) return precision >= MIN_PRECISION || strong ? 'weak' : 'not_found';
  // No word in common: only trust the search's own meaning match, and flag it.
  return strong ? 'weak' : 'not_found';
}

/** Candidates whose score is this close to the best count as matching about equally well. */
export const SIMILAR_SCORE = 0.15;

export interface Orderability {
  score: number;
  /** In the best tier of match ("matched", not "check this"). */
  matched: boolean;
  /** Valio's price gave a pack size, so a quantity could be worked out. */
  sized: boolean;
  /** Valio can deliver it as asked (stock, cut-off, delivery). */
  deliverable: boolean;
}

/**
 * Puts a product Valio can size and deliver ahead of one it cannot, among products that match about equally well: within
 * `SIMILAR_SCORE` of the best score and not in a weaker tier than the best. A clearly worse match is never promoted for being
 * orderable (a wrong product that can be ordered is worse than an honest "can't order"). `items` is best match first; the
 * result keeps that order within each group.
 */
export function orderByOrderability<T>(items: T[], info: (item: T) => Orderability): T[] {
  if (items.length === 0) return items;
  const top = info(items[0]);
  const rank = (item: T) => {
    const x = info(item);
    if (x.score < top.score - SIMILAR_SCORE || (top.matched && !x.matched)) return 0;
    return x.sized ? (x.deliverable ? 2 : 1) : 0;
  };
  return items
    .map((item, i) => ({ item, i, rank: rank(item), score: info(item).score }))
    .sort((a, b) => b.rank - a.rank || b.score - a.score || a.i - b.i)
    .map((x) => x.item);
}
