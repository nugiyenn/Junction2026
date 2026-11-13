import type { Candidate, Offer, OfferKind, OfferLine, PurchaseRequest } from '../types/index.ts';

// Pure: no database, no API calls. Turns priced candidates into the ways the request can be filled.

const KIND_LABEL: Record<OfferKind, string> = {
  cheapest: 'Cheapest',
  most_reliable: 'Most reliable',
  lowest_co2: 'Lowest CO2',
  split: 'Split across products',
  substitute: 'Substitute',
};

/** Longest split worth proposing. More products than this is a sign the request should be rethought. */
const MAX_SPLIT_LINES = 3;

const round2 = (n: number) => Math.round(n * 100) / 100;

function lineFor(c: Candidate, quantity: number): OfferLine {
  const unitPrice = c.unitPrice;
  return {
    productId: c.productId,
    name: c.name,
    quantity,
    salesUnit: c.salesUnit,
    unitPrice,
    lineTotal: unitPrice === null ? null : round2(unitPrice * quantity),
    amountCovered: c.amountPerUnit === null ? null : round2(c.amountPerUnit * quantity),
    ...(c.substituteFor ? { substituteFor: c.substituteFor } : {}),
  };
}

function assemble(kinds: OfferKind[], lines: OfferLine[], byId: Map<string, Candidate>, summary: string): Offer {
  const cands = lines.map((l) => byId.get(l.productId)!);
  const reliabilities = cands.map((c) => c.deliveryReliability);
  const covered = lines.map((l) => l.amountCovered ?? 0);
  const totalCovered = covered.reduce((a, b) => a + b, 0);
  const co2s = cands.map((c) => c.co2PerKg);

  return {
    id: lines.map((l) => l.productId).join('+'),
    kinds,
    label: kinds.map((k) => KIND_LABEL[k]).join(' · '),
    lines,
    total: round2(lines.reduce((sum, l) => sum + (l.lineTotal ?? 0), 0)),
    reliability: reliabilities.some((r) => r === null) ? null : Math.min(...(reliabilities as number[])),
    co2PerKg:
      co2s.some((c) => c === null) || totalCovered === 0
        ? null
        : round2((co2s as number[]).reduce((sum, c, i) => sum + c * covered[i], 0) / totalCovered),
    labels: [...new Set(cands.flatMap((c) => c.labels))],
    logisticModels: [...new Set(cands.map((c) => c.logisticModel).filter((m): m is 'Stock' | 'Terminal' => m !== null))],
    isSplit: lines.length > 1,
    isSubstitute: lines.some((l) => l.substituteFor !== undefined),
    summary,
  };
}

/** Fills the request from the cheapest stock first, using confirmed Stock quantities only. Null if it cannot be covered. */
function allocateSplit(candidates: Candidate[], request: PurchaseRequest): OfferLine[] | null {
  const pool = candidates
    .filter((c) => c.onlyShort && c.availableAmount !== null && c.availableAmount > 0 && c.amountPerUnit !== null && c.unitPrice !== null)
    .sort((a, b) => (a.comparisonPrice ?? Infinity) - (b.comparisonPrice ?? Infinity));

  let remaining = request.amount;
  const lines: OfferLine[] = [];
  for (const c of pool) {
    if (lines.length >= MAX_SPLIT_LINES) break;
    const perUnit = c.amountPerUnit!;
    const step = c.allowedLotSize > 1 ? c.allowedLotSize : 1;
    const wanted = Math.ceil(remaining / perUnit);
    const units = Math.floor(Math.min(wanted, c.availableAmount!) / step) * step;
    if (units <= 0) continue;
    lines.push(lineFor(c, units));
    remaining -= units * perUnit;
    if (remaining <= 1e-9) return lines;
  }
  return null;
}

/**
 * The ways to fill a request, default first:
 * 1. Products that can deliver everything: the cheapest, the most reliable and the lowest-CO2, merged when one
 *    product wins several.
 * 2. If none can, a split across products using confirmed stock.
 * 3. If that cannot cover it either, Valio's listed substitutes (a human must sign these off).
 */
export function buildOffers(candidates: Candidate[], request: PurchaseRequest): { offers: Offer[]; notes: string[] } {
  const byId = new Map(candidates.map((c) => [c.productId, c]));
  const regular = candidates.filter((c) => c.substituteFor === null);
  const substitutes = candidates.filter((c) => c.substituteFor !== null);
  const total = (c: Candidate) => c.total ?? Infinity;
  const notes: string[] = [];
  const unit = request.amountUnit === 'unit' ? '' : ` ${request.amountUnit}`;

  const full = regular.filter((c) => c.fulfillable && c.quantity !== null);
  if (full.length > 0) {
    const winners = new Map<string, OfferKind[]>();
    const add = (c: Candidate | undefined, kind: OfferKind) => c && winners.set(c.productId, [...(winners.get(c.productId) ?? []), kind]);

    add([...full].sort((a, b) => total(a) - total(b))[0], 'cheapest');
    add(
      [...full.filter((c) => c.deliveryReliability !== null)].sort(
        (a, b) => b.deliveryReliability! - a.deliveryReliability! || total(a) - total(b)
      )[0],
      'most_reliable'
    );
    add(
      [...full.filter((c) => c.co2PerKg !== null)].sort((a, b) => a.co2PerKg! - b.co2PerKg! || total(a) - total(b))[0],
      'lowest_co2'
    );

    const offers = [...winners].map(([id, kinds]) => {
      const c = byId.get(id)!;
      return assemble(kinds, [lineFor(c, c.quantity!)], byId, `${c.quantity} ${c.salesUnit} of ${c.name} covers the full ${request.amount}${unit}.`);
    });
    offers.sort((a, b) => a.total - b.total);
    return { offers, notes };
  }

  const split = allocateSplit(regular, request);
  if (split) {
    notes.push(`No single product can deliver ${request.amount}${unit} on ${request.deliveryDate}, so the order is split across ${split.length} products using confirmed stock.`);
    return {
      offers: [assemble(['split'], split, byId, `Split: ${split.map((l) => `${l.quantity} ${l.salesUnit} of ${l.name}`).join(' + ')}.`)],
      notes,
    };
  }

  const subs = substitutes.filter((c) => c.fulfillable && c.quantity !== null).sort((a, b) => total(a) - total(b)).slice(0, 2);
  if (subs.length > 0) {
    notes.push(
      `None of the matching products can deliver ${request.amount}${unit} on ${request.deliveryDate}. These are products Valio lists as substitutes, ` +
        `so the mandate sends an order for them to a human.`
    );
    return {
      offers: subs.map((c) =>
        assemble(['substitute'], [lineFor(c, c.quantity!)], byId, `Substitute for ${byId.get(c.substituteFor!)?.name ?? c.substituteFor}: ${c.quantity} ${c.salesUnit} of ${c.name}.`)
      ),
      notes,
    };
  }

  notes.push(`Nothing can deliver ${request.amount}${unit} on ${request.deliveryDate}, not even split or substituted.`);
  return { offers: [], notes };
}
