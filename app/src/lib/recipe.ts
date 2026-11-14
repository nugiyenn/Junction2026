import type { ParsedRecipe, RecipeLine, RecipeUnit } from '../types/index.ts';

// Pure: no database, no API calls, no model. Turns pasted recipe or shopping-list text into amount, unit and name lines.
// Finnish decimal comma always: "0,323" is 0.323 and "1,062" is 1.062. A multiplier (portions factor) is applied by the caller.

/** Most lines one recipe may hold. More than this is almost certainly the wrong text. */
export const MAX_RECIPE_LINES = 40;

/** Longest pasted text, in characters. */
export const MAX_RECIPE_CHARS = 4000;

const UNITS: Record<string, { unit: RecipeUnit; factor: number }> = {
  kg: { unit: 'KG', factor: 1 },
  g: { unit: 'KG', factor: 0.001 },
  l: { unit: 'L', factor: 1 },
  dl: { unit: 'L', factor: 0.1 },
  cl: { unit: 'L', factor: 0.01 },
  ml: { unit: 'L', factor: 0.001 },
  kpl: { unit: 'unit', factor: 1 },
  pcs: { unit: 'unit', factor: 1 },
  pc: { unit: 'unit', factor: 1 },
  st: { unit: 'unit', factor: 1 },
};

const NUM = String.raw`\d+(?:[.,]\d+)?`;
const UNIT = String.raw`(?:kg|g|l|dl|cl|ml|kpl|pcs|pc|st)(?![\p{L}\p{N}])`;

/** "0,323 kg" and nothing else. */
const QTY_ONLY = new RegExp(String.raw`^(${NUM})\s*(${UNIT})\s*[:.]?$`, 'iu');
/** "0,277 kg Oddlygood Dream Fraiche", "20 kg of mozzarella". */
const QTY_FIRST = new RegExp(String.raw`^(${NUM})\s*(${UNIT})\s*(?:of\s+|x\s+)?(.+)$`, 'iu');
/** "mozzarella 20 kg", "mozzarella: 20 kg". */
const NAME_FIRST = new RegExp(String.raw`^(.+?)\s*[:\-–]?\s+(${NUM})\s*(${UNIT})$`, 'iu');
/** "3 pizza boxes", "2 x pizza dough": a bare count of pieces. */
const COUNT_FIRST = new RegExp(String.raw`^(${NUM})\s*x?\s+(\p{L}.*)$`, 'iu');

const BULLET = /^\s*(?:[-*•–·▪●]\s+)/u;
const LINK = /\[([^\]\n]*)\]\((https?:\/\/[^)\s]+)\)/g;
const BARE_URL = /^(https?:\/\/\S+)$/i;
const TRAILING_WORDS = /\s+(?:tuotetta|tuote|tuotteet|product|products)\s*$/i;
const PLACEHOLDER = /(\d+)/g;

/** "and", "ja", "och" between two things: one line that names several products. */
const CONJUNCTION = /(?:^|\s)(?:and|ja|och|sekä)(?:\s|$)/i;
const HAS_NUMBER = /(?:^|\s)\d+(?:[.,]\d+)?(?:\s|$|[\p{L}])/u;

/**
 * A name that carries a second amount ("packs of mozzarella and 3 buckets of cream cheese") means the line holds several
 * products, which would become one wrong line. A name with "and" or "ja" in a name-first line ("mozzarella and tomato 20 kg")
 * is just as unclear. Both are left unread: a wrong line is worse than none.
 */
function severalProducts(name: string, nameFirst: boolean): boolean {
  return CONJUNCTION.test(name) && (nameFirst || HAS_NUMBER.test(name));
}

const toNumber = (s: string) => Number(s.replace(',', '.'));

/** The product words of a Valio product link: ".../ammattilaistuotteet/oddlygood-cooking-oat-original/1-l-tolkki/" gives "oddlygood cooking oat original". */
export function slugWords(link: string): string {
  let segments: string[];
  try {
    segments = new URL(link).pathname.split('/').filter(Boolean);
  } catch {
    return '';
  }
  const at = segments.indexOf('ammattilaistuotteet');
  const slug = (at >= 0 ? segments[at + 1] : segments[segments.length - 1]) ?? '';
  return decodeURIComponent(slug).replace(/[-_]+/g, ' ').trim();
}

/** Drops ®, ™, trailing "tuotetta", bullets' leftovers and stray punctuation; collapses spaces. */
export function cleanName(raw: string): string {
  let name = raw.replace(/[®™©]/g, '').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 2; i++) name = name.replace(TRAILING_WORDS, '').trim();
  return name.replace(/^[\s:;,.\-–]+|[\s:;,.\-–]+$/g, '').trim();
}

type Link = { text: string; url: string };

function restore(name: string, links: Link[]): { name: string; link?: string } {
  const first = [...name.matchAll(PLACEHOLDER)][0];
  if (first) {
    const link = links[Number(first[1])];
    const text = name.replace(PLACEHOLDER, (_, i: string) => links[Number(i)].text);
    return { name: cleanName(text) || cleanName(slugWords(link.url)), link: link.url };
  }
  const bare = BARE_URL.exec(name.trim());
  if (bare) return { name: cleanName(slugWords(bare[1])), link: bare[1] };
  return { name: cleanName(name) };
}

/** A comma or semicolon separates items, except a decimal comma between two digits ("0,323"). */
const SEPARATOR = /;|(?<!\d),|,(?!\d)/;

interface Quantity {
  amount: number;
  unit: RecipeUnit;
}

function quantity(num: string, unit: string): Quantity | null {
  const u = UNITS[unit.toLowerCase()];
  const value = toNumber(num) * u.factor;
  if (!Number.isFinite(value) || value <= 0) return null;
  return { amount: Number(value.toFixed(6)), unit: u.unit };
}

/**
 * Reads recipe or shopping-list text into lines. Understands a quantity line followed by the name on the next line, one
 * line with amount and name either way round, bulleted lists and comma or semicolon separated lists. Anything it cannot
 * read as an amount with a name goes to `skipped` (never silently dropped).
 */
export function parseRecipe(text: string): ParsedRecipe {
  const lines: RecipeLine[] = [];
  const skipped: string[] = [];
  let pending: { qty: Quantity; raw: string } | null = null;

  const add = (raw: string, name: string, link: string | undefined, qty: Quantity) => {
    if (!name) {
      skipped.push(raw);
      return;
    }
    lines.push({ raw, name, amount: qty.amount, unit: qty.unit, ...(link ? { link } : {}) });
  };
  const flushPending = () => {
    if (pending) skipped.push(pending.raw);
    pending = null;
  };

  for (const original of text.split(/\r?\n/)) {
    const links: Link[] = [];
    const masked = original.replace(LINK, (_m, linkText: string, url: string) => `${links.push({ text: linkText, url }) - 1}`);
    const line = masked.replace(BULLET, '').trim();
    if (line === '') continue;
    const shown = original.replace(BULLET, '').trim();

    // The name of a quantity line that stood alone on the line before.
    const onlyQty = QTY_ONLY.exec(line);
    if (onlyQty) {
      flushPending();
      const qty = quantity(onlyQty[1], onlyQty[2]);
      if (qty) pending = { qty, raw: shown };
      else skipped.push(shown);
      continue;
    }

    const segments = line.split(SEPARATOR).map((s) => s.trim()).filter(Boolean);

    if (pending && segments.length >= 1 && !QTY_FIRST.test(segments[0]) && !NAME_FIRST.test(segments[0]) && !COUNT_FIRST.test(segments[0])) {
      // The next line names the amount above it. Only the first segment is the name; the rest are read on their own below.
      const { name, link } = restore(segments[0], links);
      if (severalProducts(name, false)) skipped.push(`${pending.raw} ${shown}`);
      else add(`${pending.raw} ${shown}`, name, link, pending.qty);
      pending = null;
      segments.shift();
    } else {
      flushPending();
    }

    for (const segment of segments) {
      const raw = segments.length === 1 ? shown : restoreText(segment, links);
      const first = QTY_FIRST.exec(segment);
      if (first) {
        const qty = quantity(first[1], first[2]);
        const { name, link } = restore(first[3], links);
        if (qty && !severalProducts(name, false)) add(raw, name, link, qty);
        else skipped.push(raw);
        continue;
      }
      const last = NAME_FIRST.exec(segment);
      if (last) {
        const qty = quantity(last[2], last[3]);
        const { name, link } = restore(last[1], links);
        if (qty && !severalProducts(name, true)) add(raw, name, link, qty);
        else skipped.push(raw);
        continue;
      }
      const count = COUNT_FIRST.exec(segment);
      if (count) {
        const value = toNumber(count[1]);
        const { name, link } = restore(count[2], links);
        if (value > 0 && Number.isFinite(value) && !severalProducts(name, false)) add(raw, name, link, { amount: Number(value.toFixed(6)), unit: 'unit' });
        else skipped.push(raw);
        continue;
      }
      skipped.push(raw);
    }
  }
  flushPending();
  return { lines, skipped };
}

/** The visible text of a segment with its links put back as "[text](url)". */
function restoreText(segment: string, links: Link[]): string {
  return segment.replace(PLACEHOLDER, (_m, i: string) => `[${links[Number(i)].text}](${links[Number(i)].url})`);
}

/**
 * The delivery date to propose when the buyer gave none: the first weekday at least three days after today
 * (today is YYYY-MM-DD, Helsinki). Saturday and Sunday are skipped.
 */
export function defaultDeliveryDate(todayIso: string, daysAhead = 3): string {
  const date = new Date(`${todayIso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + daysAhead);
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}
