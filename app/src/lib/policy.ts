import type { Mandate, PolicyDecision, PolicyOutcome, Product, Quote } from '@/types';

const SEVERITY: Record<PolicyOutcome, number> = { auto_approve: 0, needs_approval: 1, reject: 2 };

/**
 * Decides whether the agent may place this order on its own.
 * Pure: every rule that fires adds a reason, and the strictest outcome wins.
 */
export function evaluateOrder(mandate: Mandate, quote: Quote, products: Map<string, Product>): PolicyDecision {
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
  }

  return { outcome, reasons };
}
