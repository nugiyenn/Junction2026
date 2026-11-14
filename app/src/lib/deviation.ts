import { roundPackSize } from './packs.ts';
import type { DeviationCheck, DeviationHistoryLine, DeviationHistoryOrder, DeviationReport, Product } from '../types/index.ts';

// Pure: no database, no model. The "unusual order" check. A large buyer's agent places much the same order every week;
// when it suddenly orders whole milk instead of skimmed, or ten times the quantity, this notices and a person decides.
// The baseline is the buyer's own past orders, read with robust statistics (median and median absolute deviation), so one
// odd week does not move it. Code decides; nothing here asks a model.

/** Everything that can be tuned. The values below are the defaults; pass a partial `options` to change any of them. */
export interface DeviationOptions {
  /** The baseline reads the most recent this-many weeks that have an approved order. */
  windowWeeks: number;
  /** A product is a standing line when it was ordered in at least this many of those weeks ... */
  standingMinWeeks: number;
  /** ... and in at least this many orders. With fewer there is no baseline for it (cold start). */
  minOrdersForBaseline: number;
  /** Tolerance around the median quantity (or total): the larger of this many MADs ... */
  toleranceMadFactor: number;
  /** ... and this share of the median. */
  tolerancePctFloor: number;
  /** A quantity this many times the median or more, or its inverse or less, always needs a person. */
  ratioHigh: number;
  ratioLow: number;
  /** Fat and lactose per 100 g: a difference of at least this many grams is a different product. */
  fatDiffG: number;
  lactoseDiffG: number;
  /** A new item or category that carries more than this share of the order total needs a person; less is information. */
  newItemShare: number;
}

export const WINDOW_WEEKS = 12;
export const STANDING_MIN_WEEKS = 3;
export const MIN_ORDERS_FOR_BASELINE = 4;
export const TOLERANCE_MAD_FACTOR = 3;
export const TOLERANCE_PCT_FLOOR = 0.2;
export const RATIO_HIGH = 2;
export const RATIO_LOW = 0.5;
export const FAT_DIFF_G = 0.5;
export const LACTOSE_DIFF_G = 0.5;
export const NEW_ITEM_SHARE = 0.25;

export const DEFAULT_OPTIONS: DeviationOptions = {
  windowWeeks: WINDOW_WEEKS,
  standingMinWeeks: STANDING_MIN_WEEKS,
  minOrdersForBaseline: MIN_ORDERS_FOR_BASELINE,
  toleranceMadFactor: TOLERANCE_MAD_FACTOR,
  tolerancePctFloor: TOLERANCE_PCT_FLOOR,
  ratioHigh: RATIO_HIGH,
  ratioLow: RATIO_LOW,
  fatDiffG: FAT_DIFF_G,
  lactoseDiffG: LACTOSE_DIFF_G,
  newItemShare: NEW_ITEM_SHARE,
};

/**
 * The only thing an agent is told. The details (what is usual, the numbers) go to the approver, never to the agent:
 * they would show a buyer's habits to whoever holds the agent API.
 */
export const DEVIATION_REASON = "Needs approval: differs from this buyer's usual orders.";

/** Diet claims and labels worth comparing. Catalog claims are full of noise (FREE_FROM_ADDITIVES); these change what a kitchen can serve. */
const DIET_CLAIMS: Record<string, string> = {
  FREE_FROM_LACTOSE: 'lactose free',
  LOW_LACTOSE: 'low lactose',
  VEGAN: 'vegan',
  VEGETARIAN: 'vegetarian',
  FREE_FROM_GLUTEN: 'gluten free',
  EU_ORGANIC_FARMING: 'organic',
};

const ALLERGEN_NAMES: Record<string, string> = {
  AM: 'milk',
  AE: 'egg',
  AF: 'fish',
  AN: 'tree nuts',
  AP: 'peanuts',
  AS: 'sesame',
  AY: 'soy',
  AC: 'crustaceans',
  AW: 'gluten cereals',
  BC: 'celery',
  BM: 'mustard',
  AU: 'sulphites',
  GO: 'oats',
  ML: 'lactose',
};

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const EPS = 1e-9;

// --- small helpers -----------------------------------------------------------

export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Median absolute deviation: the robust cousin of the standard deviation. */
export function mad(values: number[]): number {
  const m = median(values);
  return median(values.map((v) => Math.abs(v - m)));
}

/** The range around a typical value inside which an amount counts as usual. */
export function tolerance(values: number[], o: Pick<DeviationOptions, 'toleranceMadFactor' | 'tolerancePctFloor'> = DEFAULT_OPTIONS) {
  const mid = median(values);
  const half = Math.max(o.toleranceMadFactor * mad(values), o.tolerancePctFloor * Math.abs(mid));
  return { median: mid, low: mid - half, high: mid + half };
}

const num = (n: number) => (Math.round(n * 10) / 10).toLocaleString('en-GB', { maximumFractionDigits: 1 });
const signed = (n: number) => `${n >= 0 ? '+' : '-'}${num(Math.abs(n))}`;
const UNIT_LABEL = { L: 'L', KG: 'kg', unit: 'packs' } as const;
const amountText = (n: number, unit: DeviationHistoryLine['unit']) => `${num(n)} ${UNIT_LABEL[unit]}`;
const rangeText = (low: number, high: number) => `${num(Math.max(low, 0))} to ${num(high)}`;
const eur = (n: number) => `€${n.toLocaleString('en-GB', { maximumFractionDigits: 0 })}`;

const dateOf = (o: { deliveryDate?: string | null; at: string }) => (o.deliveryDate || o.at).slice(0, 10);

/** Monday of the week a YYYY-MM-DD date falls in. */
function weekOf(date: string): string {
  const t = Date.parse(`${date}T00:00:00Z`);
  const day = new Date(t).getUTCDay();
  return new Date(t - ((day + 6) % 7) * 86_400_000).toISOString().slice(0, 10);
}

const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

const productName = (p: Product | undefined, fallback: string) => p?.nameEn ?? p?.nameFi ?? fallback;

const nutrient = (p: Product, code: string): number | null => {
  const v = p.nutrition?.[code]?.value;
  return typeof v === 'number' ? v : null;
};

const allergenList = (codes: string[]) => (codes.length ? codes.map((c) => ALLERGEN_NAMES[c] ?? c).join(', ') : 'none');
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** Diet claims and labels of a product, as plain words. */
const dietClaims = (p: Product): string[] =>
  [...new Set([...(p.claims ?? []), ...(p.labels ?? [])])].filter((c) => c in DIET_CLAIMS).map((c) => DIET_CLAIMS[c]).sort();

/**
 * Litres or kilos in an order line: the pack size follows from the line's price and its price per litre or kilo, then
 * times the packs. A swap between pack sizes (a 10 l box for ten 1 l packs) is then the same amount. Without a price per
 * litre or kilo the size is unknown and the line is counted in packs.
 */
export function lineAmount(l: {
  quantity: number;
  unitPrice?: number | null;
  comparisonPrice?: number | null;
  comparisonUnit?: string | null;
}): { amount: number; unit: DeviationHistoryLine['unit'] } {
  const unit = l.comparisonUnit?.toUpperCase();
  if ((unit === 'L' || unit === 'KG') && l.unitPrice && l.comparisonPrice && l.unitPrice > 0 && l.comparisonPrice > 0) {
    return { amount: Math.round(l.quantity * roundPackSize(l.unitPrice / l.comparisonPrice) * 1000) / 1000, unit };
  }
  return { amount: l.quantity, unit: 'unit' };
}

// --- baseline ----------------------------------------------------------------

export interface DeviationOrderInput {
  /** YYYY-MM-DD */
  deliveryDate: string;
  total: number;
  lines: {
    productId: string;
    name: string;
    quantity: number;
    unitPrice?: number | null;
    comparisonPrice?: number | null;
    comparisonUnit?: string | null;
    lineTotal?: number | null;
  }[];
}

interface Occurrence {
  amount: number;
  week: string;
  at: string;
  /** From an order a person accepted as the new normal. */
  accepted: boolean;
}

interface StandingLine {
  productId: string;
  name: string;
  unit: DeviationHistoryLine['unit'];
  orders: number;
  median: number;
  low: number;
  high: number;
}

interface Baseline {
  basedOn: number;
  standing: Map<string, StandingLine>;
  /** Every product the buyer has ordered before (not only standing ones), to tell a new item from a rare one. */
  seen: Set<string>;
  weekday: { day: number; count: number };
  total: { median: number; low: number; high: number };
}

/**
 * Orders the baseline may learn from: not flagged, or flagged and then accepted by a person as the new normal. A flagged
 * order that was approved without that choice was a one-off and must not teach the baseline.
 */
const learnable = (o: DeviationHistoryOrder) =>
  (!o.flagged || o.acceptedAsNormal) && o.lines.some((l) => Number.isFinite(l.amount) && l.amount > 0);

function buildBaseline(history: DeviationHistoryOrder[], o: DeviationOptions): Baseline | null {
  const eligible = history.filter(learnable);
  const recentWeeks = (orders: DeviationHistoryOrder[], n: number) =>
    [...new Set(orders.map((h) => weekOf(dateOf(h))))].sort().reverse().slice(0, n);

  // Which products are ordered habitually at all, over twice the window. An unrelated order in a new week (a one-off
  // purchase of something else) must not push a week of the standing order out of the window, so the window is made
  // of the latest weeks that have an order with a habitual product in it.
  const lookback = recentWeeks(eligible, o.windowWeeks * 2);
  const habitual = new Map<string, { weeks: Set<string>; orders: number }>();
  for (const h of eligible) {
    const week = weekOf(dateOf(h));
    if (!lookback.includes(week)) continue;
    for (const l of h.lines) {
      const e = habitual.get(l.productId) ?? { weeks: new Set<string>(), orders: 0 };
      e.weeks.add(week);
      e.orders++;
      habitual.set(l.productId, e);
    }
  }
  const candidate = (id: string, h: DeviationHistoryOrder) =>
    (h.flagged && h.acceptedAsNormal) ||
    ((habitual.get(id)?.weeks.size ?? 0) >= o.standingMinWeeks && (habitual.get(id)?.orders ?? 0) >= o.minOrdersForBaseline);
  const withHabit = eligible.filter((h) => lookback.includes(weekOf(dateOf(h))) && h.lines.some((l) => candidate(l.productId, h)));
  const weeks = recentWeeks(withHabit, o.windowWeeks);
  const inWindow = eligible.filter((h) => weeks.includes(weekOf(dateOf(h))));

  // What a person accepted as the new normal is a usual product at once, however few times it was ordered.
  const accepted = new Set(inWindow.filter((h) => h.flagged && h.acceptedAsNormal).flatMap((h) => h.lines.map((l) => l.productId)));
  const byProduct = new Map<string, { name: string; unit: DeviationHistoryLine['unit']; occ: Occurrence[] }[]>();
  for (const h of inWindow) {
    const week = weekOf(dateOf(h));
    for (const l of h.lines) {
      if (!(l.amount > 0)) continue;
      const variants = byProduct.get(l.productId) ?? [];
      let v = variants.find((x) => x.unit === l.unit);
      if (!v) variants.push((v = { name: l.name, unit: l.unit, occ: [] }));
      v.occ.push({ amount: l.amount, week, at: h.at, accepted: Boolean(h.flagged && h.acceptedAsNormal) });
      byProduct.set(l.productId, variants);
    }
  }

  const standing = new Map<string, StandingLine>();
  for (const [productId, variants] of byProduct) {
    // The unit the buyer mostly orders it in: an amount in litres and an amount in packs cannot be compared.
    const v = [...variants].sort((a, b) => b.occ.length - a.occ.length)[0];
    // A quantity a person accepted as the new normal replaces the earlier pattern of that product, when it differs from it:
    // otherwise a few small old orders would outvote the one the approver just said is normal. When the accepted amount is
    // in line with the earlier ones nothing changes, so accepting a whole order does not wipe the history of its other lines.
    const latest = v.occ.filter((x) => x.accepted).sort((a, b) => (a.at < b.at ? 1 : -1))[0];
    if (latest) {
      const earlier = v.occ.filter((x) => x.at < latest.at);
      if (earlier.length > 0) {
        const t = tolerance(earlier.map((x) => x.amount), o);
        if (latest.amount < t.low - EPS || latest.amount > t.high + EPS) v.occ = v.occ.filter((x) => x.at >= latest.at);
      }
    }
    const distinctWeeks = new Set(v.occ.map((x) => x.week)).size;
    if (!accepted.has(productId) && (distinctWeeks < o.standingMinWeeks || v.occ.length < o.minOrdersForBaseline)) continue;
    const t = tolerance(v.occ.map((x) => x.amount), o);
    standing.set(productId, { productId, name: v.name, unit: v.unit, orders: v.occ.length, median: t.median, low: t.low, high: t.high });
  }
  if (standing.size === 0) return null;

  const used = inWindow.filter((h) => h.lines.some((l) => standing.has(l.productId)));
  const days = new Map<number, number>();
  for (const h of used) days.set(weekdayOf(dateOf(h)), (days.get(weekdayOf(dateOf(h))) ?? 0) + 1);
  // Mode; on a tie the most recent order's weekday wins.
  const latest = weekdayOf(dateOf([...used].sort((a, b) => dateOf(b).localeCompare(dateOf(a)))[0]));
  const [day, count] = [...days.entries()].sort((a, b) => b[1] - a[1] || (a[0] === latest ? -1 : b[0] === latest ? 1 : 0))[0];

  return {
    basedOn: used.length,
    standing,
    seen: new Set(eligible.flatMap((h) => h.lines.map((l) => l.productId))),
    weekday: { day, count },
    total: tolerance(used.map((h) => h.total), o),
  };
}

// --- checks -------------------------------------------------------------------

type Draft = DeviationCheck;

/** The rows that compare a product with the one the buyer usually orders. They are one finding. */
function attributeRows(usual: Product, now: Product, group: string, line: string, o: DeviationOptions): Draft[] {
  const rows: Draft[] = [];
  const gram = (label: string, id: string, code: string, threshold: number): Draft => {
    const a = nutrient(usual, code);
    const b = nutrient(now, code);
    if (a === null || b === null) {
      return { id: `${id}:${group}`, label, usual: a === null ? 'no data' : `${num(a)} g`, thisOrder: b === null ? 'no data' : `${num(b)} g`, result: 'info', detail: 'No data', group, line };
    }
    const differs = Math.abs(b - a) >= threshold - EPS;
    return {
      id: `${id}:${group}`,
      label,
      usual: `${num(a)} g`,
      thisOrder: `${num(b)} g`,
      result: differs ? 'review' : 'usual',
      detail: differs ? `${signed(b - a)} g` : 'Same',
      group,
      line,
    };
  };
  rows.push(gram('Fat per 100 g', 'fat', 'FAT', o.fatDiffG));
  rows.push(gram('Lactose per 100 g', 'lactose', 'LACS', o.lactoseDiffG));

  const sameAllergens = sameSet(usual.allergensContain, now.allergensContain) && sameSet(usual.allergensMayContain, now.allergensMayContain);
  const allergenText = (p: Product) =>
    allergenList(p.allergensContain) + (p.allergensMayContain.length ? `; may contain ${allergenList(p.allergensMayContain)}` : '');
  rows.push({
    id: `allergens:${group}`,
    label: 'Allergens',
    usual: allergenText(usual),
    thisOrder: allergenText(now),
    result: sameAllergens ? 'usual' : 'review',
    detail: sameAllergens ? 'Same' : 'Different',
    group,
    line,
  });

  const a = dietClaims(usual);
  const b = dietClaims(now);
  if (!sameSet(a, b)) {
    const parts = [...b.filter((c) => !a.includes(c)).map((c) => `+ ${c}`), ...a.filter((c) => !b.includes(c)).map((c) => `- ${c}`)];
    rows.push({
      id: `claims:${group}`,
      label: 'Diet claims',
      usual: a.join(', ') || 'none',
      thisOrder: b.join(', ') || 'none',
      result: 'review',
      detail: parts.join(', '),
      group,
      line,
    });
  }
  return rows;
}

function quantityCheck(
  id: string,
  line: string,
  base: StandingLine,
  amount: number,
  unit: DeviationHistoryLine['unit'],
  o: DeviationOptions
): { check: Draft; finding?: string } {
  const usual = `${amountText(base.median, base.unit)} (${rangeText(base.low, base.high)})`;
  if (unit !== base.unit) {
    return { check: { id, label: 'Quantity', usual, thisOrder: amountText(amount, unit), result: 'info', detail: 'Pack size unknown', group: id, line } };
  }
  const ratio = base.median > 0 ? amount / base.median : 1;
  const outside = amount < base.low - EPS || amount > base.high + EPS || ratio >= o.ratioHigh - EPS || ratio <= o.ratioLow + EPS;
  const pct = base.median > 0 ? Math.round((ratio - 1) * 100) : 0;
  const detail = outside ? (ratio >= 2 ? `${num(ratio)}x` : `${pct > 0 ? '+' : ''}${pct}%`) : 'As usual';
  return {
    check: { id, label: 'Quantity', usual, thisOrder: amountText(amount, unit), result: outside ? 'review' : 'usual', detail, group: id, line },
    finding: outside ? `${line}: ${amountText(amount, unit)} instead of the usual ${amountText(base.median, base.unit)}.` : undefined,
  };
}

/**
 * Compares an order with the buyer's past orders.
 *
 * `history` are the past orders of the same mandate. A product is a standing line when the buyer ordered it in at least
 * `standingMinWeeks` of the last `windowWeeks` weeks and in at least `minOrdersForBaseline` orders; a buyer with no standing
 * line has no baseline and nothing is flagged. For each line of the new order the report compares what is usual (median
 * amount, tolerance, delivery weekday, total, the product's attributes) with what is ordered. A `review` finding is a reason
 * for a person to look; `info` is shown but never a reason alone. `products` must hold the catalog rows of the order's
 * products and of the standing products.
 */
export function detectDeviations(
  history: DeviationHistoryOrder[],
  order: DeviationOrderInput,
  products: Map<string, Product>,
  options: Partial<DeviationOptions> = {}
): DeviationReport {
  const o: DeviationOptions = { ...DEFAULT_OPTIONS, ...options };
  const baseline = buildBaseline(history, o);
  if (!baseline) {
    const past = history.filter(learnable).length;
    return { basedOn: past, hasBaseline: false, checks: [], differing: 0, total: 0, findings: [] };
  }

  const checks: Draft[] = [];
  const findings: string[] = [];
  const orderedIds = new Set(order.lines.map((l) => l.productId));
  const taken = new Set<string>();

  for (const l of order.lines) {
    const product = products.get(l.productId);
    const name = productName(product, l.name);
    const { amount, unit } = lineAmount(l);
    const standing = baseline.standing.get(l.productId);

    if (standing) {
      const usualProduct = product;
      checks.push({ id: `product:${l.productId}`, label: 'Product', usual: standing.name, thisOrder: name, result: 'usual', detail: 'Same product', group: `product:${l.productId}`, line: name });
      const q = quantityCheck(`quantity:${l.productId}`, name, standing, amount, unit, o);
      checks.push(q.check);
      if (q.finding) findings.push(q.finding);
      if (usualProduct) {
        // The same product has the same attributes: lactose and allergens are shown as evidence, each a finding of its own.
        const rows = attributeRows(usualProduct, usualProduct, `same:${l.productId}`, name, o).filter((r) => r.label === 'Lactose per 100 g' || r.label === 'Allergens');
        for (const r of rows) checks.push({ ...r, group: `${r.label === 'Allergens' ? 'allergens' : 'lactose'}:${l.productId}` });
      }
      continue;
    }

    // A usual product of the same category and sales unit that is missing from this order: this line replaces it.
    const candidates = [...baseline.standing.values()]
      .filter((s) => !orderedIds.has(s.productId) && !taken.has(s.productId))
      .filter((s) => {
        const usual = products.get(s.productId);
        return usual && product && usual.category !== null && usual.category === product.category && usual.salesUnit === product.salesUnit;
      })
      // The closest usual amount; then the product ordered most often (a one-off accepted as normal does not outrank the weekly order).
      .sort((a, b) => Math.abs(a.median - amount) - Math.abs(b.median - amount) || b.orders - a.orders || (a.productId < b.productId ? -1 : 1));
    const partner = candidates[0];

    if (partner && product) {
      taken.add(partner.productId);
      const usualProduct = products.get(partner.productId)!;
      const group = `swap:${l.productId}`;
      const rows = attributeRows(usualProduct, product, group, name, o);
      const differing = rows.filter((r) => r.result === 'review');
      checks.push({
        id: `product:${l.productId}`,
        label: 'Product',
        usual: partner.name,
        thisOrder: name,
        result: differing.length ? 'review' : 'info',
        detail: differing.length ? 'Different product' : 'Same attributes',
        group,
        line: name,
      });
      checks.push(...rows);
      if (differing.length) {
        const bits = differing.map((r) =>
          r.label === 'Allergens' ? 'different allergens' : r.label === 'Diet claims' ? `claims ${r.detail}` : `${r.label.replace(' per 100 g', '').toLowerCase()} ${r.detail} per 100 g`
        );
        findings.push(`${name} instead of ${partner.name} (${bits.join(', ')}).`);
      }
      const q = quantityCheck(`quantity:${l.productId}`, name, partner, amount, unit, o);
      checks.push(q.check);
      if (q.finding) findings.push(q.finding);
      continue;
    }

    // Not a usual product and not a replacement. A product bought before, even rarely, is not new.
    if (baseline.seen.has(l.productId)) continue;
    const categoryKnown = product?.category != null && [...baseline.seen].some((id) => products.get(id)?.category === product.category);
    const share = order.total > 0 ? (l.lineTotal ?? 0) / order.total : 0;
    const review = share > o.newItemShare + EPS;
    const pct = Math.round(share * 100);
    checks.push({
      id: `new:${l.productId}`,
      label: categoryKnown ? 'New item' : 'New category',
      usual: categoryKnown ? 'Not ordered before' : 'Category not ordered before',
      thisOrder: name,
      result: review ? 'review' : 'info',
      detail: `${pct}% of the order`,
      group: `new:${l.productId}`,
      line: name,
    });
    if (review) findings.push(`${name} is ${categoryKnown ? 'a new item' : 'in a new category'} for this buyer and makes up ${pct}% of the order.`);
  }

  // Order level. Neither is a reason by itself: a different weekday or total usually follows from the other findings.
  const day = weekdayOf(order.deliveryDate);
  const usualDay = `${WEEKDAYS[baseline.weekday.day]}, ${baseline.weekday.count} of ${baseline.basedOn}`;
  checks.push({
    id: 'weekday',
    label: 'Delivery weekday',
    usual: usualDay,
    thisOrder: WEEKDAYS[day],
    result: day === baseline.weekday.day ? 'usual' : 'info',
    detail: day === baseline.weekday.day ? 'As usual' : 'Different day',
    group: 'weekday',
  });
  const t = baseline.total;
  const inside = order.total >= t.low - EPS && order.total <= t.high + EPS;
  const delta = t.median > 0 ? Math.round((order.total / t.median - 1) * 100) : 0;
  checks.push({
    id: 'total',
    label: 'Order total',
    usual: `${eur(t.median)} (${eur(Math.max(t.low, 0))} to ${eur(t.high)})`,
    thisOrder: eur(order.total),
    result: inside ? 'usual' : 'info',
    detail: inside ? 'As usual' : `${delta > 0 ? '+' : ''}${delta}%`,
    group: 'total',
  });

  const groups = new Map<string, boolean>();
  for (const c of checks) groups.set(c.group ?? c.id, (groups.get(c.group ?? c.id) ?? false) || c.result === 'review');
  return {
    basedOn: baseline.basedOn,
    hasBaseline: true,
    checks,
    differing: [...groups.values()].filter(Boolean).length,
    total: groups.size,
    findings,
  };
}
