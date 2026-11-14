import { DEVIATION_REASON } from './deviation.ts';
import { isTrustedSource } from './evidence.ts';
import type { Mandate, PolicyContext, PolicyDecision, PolicyOutcome, Product, Quote, RecallCheck, Verification } from '@/types';

const SEVERITY: Record<PolicyOutcome, number> = { auto_approve: 0, needs_approval: 1, reject: 2 };

/** A product with no allergen statement of any kind: its allergens are unknown, not absent. */
export const hasNoAllergenData = (p: Product) =>
  p.allergensContain.length === 0 && p.allergensMayContain.length === 0 && p.allergensFreeFrom.length === 0;

/**
 * Decides whether the agent may place this order on its own.
 * Pure: every rule that fires adds a reason, and the strictest outcome wins.
 *
 * Rules:
 * - total above the max -> reject; above the auto-approve limit -> human
 * - rolling 24 hours: the buyer's confirmed and pending orders of the last 24 h plus this one above the auto-approve
 *   limit -> human. This closes the structuring hole of many orders just under the limit. It never rejects: the maximum
 *   is a limit on one order, and cumulative spend is a reason for a person to look, not to refuse. A total exactly at the
 *   limit passes. It adds nothing when this order alone is already above the limit (that reason covers it) or when no
 *   earlier spend is known (`context.spentLast24hEur` missing or 0).
 * - a blocked allergen the product contains -> reject; may contain -> human
 * - unusual order: the order differs from this buyer's own recent orders (a different product, a quantity far outside
 *   the usual, a new item that is a large share of the order; see deviation.ts) -> human. It never rejects and never
 *   lowers a stricter outcome. The reason is one fixed sentence: the details are for the approver, not for the agent.
 * - blocked allergens on the mandate and the product has no allergen data at all -> human (unverified)
 * - a stored live-web check: a source saying "contains" a blocked allergen -> reject, "may contain" or any
 *   disagreement with the catalog -> human; a source confirming "free from" every blocked allergen clears
 *   the unverified rule above
 * - a stored recall check with a match (a Ruokavirasto notice naming the product or brand) -> human, with the notice's URL
 * - delivery reliability below the mandate's minimum -> human
 * - carbon footprint above the mandate's maximum -> human (unknown footprint passes, like unknown reliability)
 * - Terminal stock (unconfirmed) when the mandate requires confirmed stock -> human
 * - a line that substitutes what the buyer asked for -> human
 */
export function evaluateOrder(
  mandate: Mandate,
  quote: Quote,
  products: Map<string, Product>,
  /** Stored live-web checks, if any. They can clear an unverified product or stop one the catalog got wrong. */
  verifications: Map<string, Verification> = new Map(),
  /** Stored recall checks, if any. A match sends the order to a human. */
  recalls: Map<string, RecallCheck> = new Map(),
  /** What the caller knows about the buyer's recent activity. `spentLast24hEur` is confirmed plus pending orders, ex VAT, excluding this one. */
  context: PolicyContext = {}
): PolicyDecision {
  let outcome: PolicyOutcome = 'auto_approve';
  const reasons: string[] = [];
  const raise = (to: PolicyOutcome, reason: string) => {
    if (SEVERITY[to] > SEVERITY[outcome]) outcome = to;
    reasons.push(reason);
  };

  const eur = (n: number) => `${n.toFixed(2)} EUR`;
  if (quote.total > mandate.maxOrderEur) {
    raise('reject', `Order total ${eur(quote.total)} is above the mandate's maximum of ${eur(mandate.maxOrderEur)}.`);
  } else if (quote.total > mandate.autoApproveLimitEur) {
    raise(
      'needs_approval',
      `Order total ${eur(quote.total)} is above the auto-approve limit of ${eur(mandate.autoApproveLimitEur)}.`
    );
  }

  const cents = (n: number) => Math.round(n * 100);
  const spent = context.spentLast24hEur ?? 0;
  if (spent > 0 && quote.total <= mandate.autoApproveLimitEur && cents(spent + quote.total) > cents(mandate.autoApproveLimitEur)) {
    raise(
      'needs_approval',
      `Orders in the last 24 hours (${eur(spent)}) plus this one (${eur(quote.total)}) are above the auto-approve limit of ${eur(mandate.autoApproveLimitEur)}.`
    );
  }

  if ((context.deviations?.differing ?? 0) > 0) raise('needs_approval', DEVIATION_REASON);

  for (const line of quote.lines) {
    const product = products.get(line.productId);
    if (!product) {
      raise('reject', `${line.name} (${line.productId}) is no longer in the catalog.`);
      continue;
    }

    for (const allergen of mandate.blockedAllergens) {
      if (product.allergensContain.includes(allergen)) {
        raise('reject', `${line.name} contains blocked allergen ${allergen}.`);
      } else if (product.allergensMayContain.includes(allergen)) {
        raise('needs_approval', `${line.name} may contain blocked allergen ${allergen}.`);
      }
    }
    const check = verifications.get(line.productId);
    const confirmedFree = (code: string) =>
      // Only a trusted source can clear an unknown allergen (see TRUSTED_SOURCE_HOSTS in evidence.ts); any page can add a concern.
      check?.statements.some((s) => s.topic === 'allergen' && s.allergen === code && s.stance === 'free_from' && isTrustedSource(s.sourceUrl)) ?? false;
    if (mandate.blockedAllergens.length > 0 && hasNoAllergenData(product) && !mandate.blockedAllergens.every(confirmedFree)) {
      raise(
        'needs_approval',
        `${line.name} has no allergen data, so it cannot be confirmed free of ${mandate.blockedAllergens.join(', ')}.`
      );
    }
    if (check) {
      for (const s of check.statements) {
        if (s.topic !== 'allergen' || !s.allergen || !mandate.blockedAllergens.includes(s.allergen)) continue;
        if (s.stance === 'contains') raise('reject', `A live source says ${line.name} contains blocked allergen ${s.allergen} (${s.sourceUrl}).`);
        if (s.stance === 'may_contain') raise('needs_approval', `A live source says ${line.name} may contain blocked allergen ${s.allergen} (${s.sourceUrl}).`);
      }
      if (check.status === 'contradiction') {
        raise('needs_approval', `A live check of ${line.name} disagrees with the catalog: ${check.contradictions[0]}`);
      }
    }

    const recall = recalls.get(line.productId);
    if (recall?.status === 'match' && recall.matches.length > 0) {
      const m = recall.matches[0];
      raise('needs_approval', `A recall notice may cover ${line.name}: "${m.quote.replace(/[*\s]+/g, ' ')}" (${m.sourceUrl}).`);
    }

    if (
      mandate.minDeliveryReliability !== null &&
      product.deliveryReliability !== null &&
      product.deliveryReliability < mandate.minDeliveryReliability
    ) {
      raise(
        'needs_approval',
        `${line.name} was delivered in full only ${Math.round(product.deliveryReliability * 100)}% of the time, ` +
          `below the mandate's ${Math.round(mandate.minDeliveryReliability * 100)}%.`
      );
    }

    if (mandate.maxCo2PerKg !== null && product.co2PerKg !== null && product.co2PerKg > mandate.maxCo2PerKg) {
      raise(
        'needs_approval',
        `${line.name} has a carbon footprint of ${product.co2PerKg} kg CO2-eq per kg, ` +
          `above the mandate's ${mandate.maxCo2PerKg}.`
      );
    }

    if (mandate.requireConfirmedStock && line.logisticModel === 'Terminal') {
      raise('needs_approval', `${line.name} ships from the supplier's warehouse, so its stock is unconfirmed.`);
    }

    if (line.isSubstitute) {
      raise('needs_approval', `${line.name} is a substitute for what was requested.`);
    }
  }

  return { outcome, reasons };
}
