import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { DEVIATION_REASON, detectDeviations } from '../src/lib/deviation.ts';
import { exposeOrder } from '../src/lib/exposure.ts';
import { evaluateOrder } from '../src/lib/policy.ts';
import type { DeviationHistoryOrder, DeviationReport, Mandate, Order, Product, Quote, QuoteLine } from '../src/types/index.ts';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const mandate: Mandate = {
  id: 'm',
  buyerName: 'Buyer',
  agentName: 'Agent',
  autoApproveLimitEur: 2000,
  maxOrderEur: 5000,
  blockedAllergens: [],
  minDeliveryReliability: null,
  requireConfirmedStock: false,
  maxCo2PerKg: null,
  preferredOffer: 'cheapest',
};

const nutrition = (fat: number, lactose: number) => ({ FAT: { value: fat, unit: 'GRM' }, LACS: { value: lactose, unit: 'GRM' } });
const skim = { id: 'skim', nameFi: 'Kevytmaito', nameEn: 'Skimmed milk 1 l', category: '10400', salesUnit: 'ST', allergensContain: ['AM'], allergensMayContain: [], allergensFreeFrom: [], claims: [], labels: [], nutrition: nutrition(0, 4.9), deliveryReliability: 1 } as unknown as Product;
const whole = { ...skim, id: 'whole', nameFi: 'Täysmaito', nameEn: 'Whole milk 1 l', nutrition: nutrition(4.2, 4.7) } as Product;
const products = new Map([skim, whole].map((p) => [p.id, p]));

const MONDAY = Date.UTC(2026, 10, 9);
const day = (weeksAgo: number) => new Date(MONDAY - weeksAgo * 7 * 86_400_000).toISOString().slice(0, 10);
const history: DeviationHistoryOrder[] = Array.from({ length: 12 }, (_, i) => ({
  id: `h${i}`,
  at: `${day(i + 1)}T08:00:00.000Z`,
  deliveryDate: day(i),
  total: 880,
  lines: [{ productId: 'skim', name: 'Skimmed milk 1 l', amount: 1000, unit: 'L' as const, total: 880 }],
}));

const quote = (productId: string, litres: number): Quote => {
  const line = { productId, name: products.get(productId)!.nameEn, quantity: litres, salesUnit: 'ST', unitPrice: 0.88, comparisonPrice: 0.88, comparisonUnit: 'L', lineTotal: litres * 0.88, logisticModel: 'Stock', fulfillable: true, issues: [] } as unknown as QuoteLine;
  return { id: 'q', mandateId: 'm', deliveryDate: day(0), total: litres * 0.88, lines: [line] } as unknown as Quote;
};

const judge = (q: Quote, m: Mandate = mandate, extra: { spentLast24hEur?: number } = {}) =>
  evaluateOrder(m, q, products, new Map(), new Map(), { ...extra, deviations: detectDeviations(history, q, products) });

describe('policy: unusual order', () => {
  it('the usual order passes with nothing to note', () => {
    assert.deepEqual(judge(quote('skim', 1000)), { outcome: 'auto_approve', reasons: [] });
  });

  it('a different product goes to a person, with the one fixed sentence', () => {
    const d = judge(quote('whole', 1000));
    assert.equal(d.outcome, 'needs_approval');
    assert.deepEqual(d.reasons, [DEVIATION_REASON]);
  });

  it('3x the quantity goes to a person; +20 % does not', () => {
    assert.equal(judge(quote('skim', 3000)).outcome, 'needs_approval');
    assert.deepEqual(judge(quote('skim', 1200)), { outcome: 'auto_approve', reasons: [] });
  });

  it('never rejects by itself, and never lowers a stricter outcome', () => {
    // 10x is 8,800 EUR: the existing maximum rejects, and the unusual-order reason is listed next to it.
    const big = judge(quote('skim', 10000));
    assert.equal(big.outcome, 'reject');
    assert.ok(big.reasons.includes(DEVIATION_REASON));
    assert.ok(big.reasons.some((r) => /maximum/.test(r)));
    // A blocked allergen still rejects.
    const strict = judge(quote('whole', 1000), { ...mandate, blockedAllergens: ['AM'] });
    assert.equal(strict.outcome, 'reject');
    // Only a person is asked when nothing else applies.
    assert.equal(judge(quote('whole', 1000)).outcome, 'needs_approval');
  });

  it('adds nothing without a baseline or without a finding', () => {
    const none: DeviationReport = { basedOn: 2, hasBaseline: false, checks: [], differing: 0, total: 0, findings: [] };
    const d = evaluateOrder(mandate, quote('whole', 1000), products, new Map(), new Map(), { deviations: none });
    assert.deepEqual(d, { outcome: 'auto_approve', reasons: [] });
    assert.deepEqual(evaluateOrder(mandate, quote('whole', 1000), products), { outcome: 'auto_approve', reasons: [] });
  });

  it('stacks with the rolling 24 hour rule without duplicating', () => {
    const d = judge(quote('whole', 1000), mandate, { spentLast24hEur: 1500 });
    assert.equal(d.outcome, 'needs_approval');
    assert.equal(d.reasons.filter((r) => r === DEVIATION_REASON).length, 1);
    assert.equal(d.reasons.length, 2);
  });
});

describe('exposure: the agent never gets the buyer\'s usual order', () => {
  const q = quote('whole', 3000);
  const report = detectDeviations(history, q, products);
  const decision = judge(q);
  const order = { id: 'o', quoteId: 'q', mandateId: 'm', status: 'pending_approval', policyReasons: decision.reasons, deliveryDate: day(0), currency: 'EUR', lines: q.lines, total: q.total, totalWithTax: q.total, createdAt: '2026-11-14T10:00:00Z', decidedBy: null, decidedAt: null, decisionNote: null } as unknown as Order;

  it('the approver report holds the numbers', () => {
    assert.equal(report.differing, 2);
    assert.ok(report.checks.some((c) => /1,000 L/.test(c.usual)));
  });

  it('what the agent gets (policy decision and exposed order) has the generic sentence and no baseline', () => {
    const agentView = JSON.stringify({ policy: decision, order: exposeOrder(order) });
    assert.ok(agentView.includes(DEVIATION_REASON));
    for (const c of report.checks.filter((x) => /\d/.test(x.usual))) assert.equal(agentView.includes(c.usual), false, `leaked: ${c.usual}`);
    for (const f of report.findings) assert.equal(agentView.includes(f), false, `leaked: ${f}`);
    for (const secret of ['800 to 1,200', 'Monday, 12 of 12', 'instead of the usual', 'basedOn', 'Fat per 100 g', '4.2 g']) {
      assert.equal(agentView.includes(secret), false, `leaked: ${secret}`);
    }
    assert.equal(/usual[^"]{0,40}\d|\d[^"]{0,40}usual/i.test(JSON.stringify(decision.reasons)), false, 'the word usual never sits next to a number');
  });
});

describe('approver-only surfaces', () => {
  it('the deviation route checks the approver key before reading anything', () => {
    const src = read('src/app/api/orders/[id]/deviation/route.ts');
    assert.match(src, /requireApprover\(request\)/);
    assert.ok(src.indexOf('requireApprover(request)') < src.indexOf('await getDeviationReport('));
    assert.match(src, /export async function GET/);
  });

  it('the decision route still checks the key first and passes acceptAsNormal on', () => {
    const src = read('src/app/api/orders/[id]/decision/route.ts');
    assert.ok(src.indexOf('requireApprover(request)') < src.indexOf('Body.parse'));
    assert.match(src, /acceptAsNormal: z\.boolean\(\)\.optional\(\)/);
  });

  it('the open audit feed never lists the report, and the agent surface has no way to read or accept one', () => {
    assert.match(read('src/lib/audit.ts'), /action <> 'deviation_report'/);
    for (const file of ['src/lib/mcp-tools.ts', 'src/lib/mcp.ts', 'src/app/api/audit/route.ts']) {
      assert.equal(/deviation|acceptAsNormal|accepted_as_normal/i.test(read(file)), false, file);
    }
  });

  it('the report is stored without a quote or order column, so receipts and the audit feed cannot serve it', () => {
    const src = read('src/lib/purchasing.ts');
    const block = src.slice(src.indexOf("action: 'deviation_report'"), src.indexOf("action: 'deviation_report'") + 400);
    assert.match(block, /quoteId: null/);
    assert.match(block, /orderId: null/);
  });

  it('OpenAPI documents the report endpoint and the accept option', () => {
    const spec = JSON.parse(read('public/openapi.json'));
    assert.ok(spec.paths['/api/orders/{id}/deviation'].get.responses['401']);
    assert.ok(spec.paths['/api/orders/{id}/decision'].post.requestBody.content['application/json'].schema.properties.acceptAsNormal);
    assert.ok(spec.components.schemas.DeviationReport);
  });
});
