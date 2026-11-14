import type { EvalAgreement, EvalCase, EvalErrorKind, EvalField, EvalModelSummary, EvalResults, EvalRun, PurchaseRequest } from '../types/index.ts';

/** Pure scoring for the model evaluation: no network, no env, so tests run it on fixed fake outputs. */

export const EVAL_FIELDS: EvalField[] = ['product', 'amount', 'amountUnit', 'deliveryDate', 'requiredClaims'];

/** Does the model's output match the hand label, field by field? Product matches if it contains any accepted keyword. */
export function scoreOutput(expected: EvalCase['expected'], output: PurchaseRequest): Record<EvalField, boolean> {
  const product = output.product.toLowerCase();
  return {
    product: expected.productAny.some((k) => product.includes(k.toLowerCase())),
    amount: Math.abs(output.amount - expected.amount) < 1e-9,
    amountUnit: output.amountUnit === expected.amountUnit,
    deliveryDate: output.deliveryDate === expected.deliveryDate,
    requiredClaims: sameSet(output.requiredClaims, expected.requiredClaims),
  };
}

const sameSet = (a: string[], b: string[]) => new Set(a).size === new Set(b).size && a.every((x) => b.includes(x));

/** Sorts a failure into: out of time, answered but not valid JSON for the schema, or any other call failure. */
export function classifyError(err: unknown): EvalErrorKind {
  const e = err as { name?: string; message?: string };
  const message = e?.message ?? '';
  if (/timed out|timeout|aborted/i.test(message) || e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'timeout';
  if (e?.name === 'ZodError' || e?.name === 'SyntaxError' || /returned no JSON|Empty response/i.test(message)) return 'invalid_output';
  return 'error';
}

/** Nearest-rank percentile of an ascending list. Null for an empty list. With few runs, p95 is the slowest one. */
export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

/** Rates are over all attempts: a failed run counts as invalid and wrong. Latency is over valid runs only. */
export function summarizeRuns(runs: EvalRun[]): EvalModelSummary {
  const attempts = runs.length;
  const valid = runs.filter((r) => r.ok);
  const rate = (n: number) => (attempts === 0 ? 0 : n / attempts);
  const latencies = valid.map((r) => r.latencyMs).sort((a, b) => a - b);
  const fieldAccuracy = Object.fromEntries(
    EVAL_FIELDS.map((f) => [f, rate(valid.filter((r) => r.correct?.[f]).length)])
  ) as Record<EvalField, number>;
  const errors: Record<EvalErrorKind, number> = { timeout: 0, invalid_output: 0, error: 0 };
  for (const r of runs) if (r.errorKind) errors[r.errorKind]++;
  return {
    attempts,
    valid: valid.length,
    validRate: rate(valid.length),
    fieldAccuracy,
    exactRate: rate(valid.filter((r) => EVAL_FIELDS.every((f) => r.correct?.[f])).length),
    latencyP50Ms: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
    errors,
  };
}

/**
 * Per case: did the models that answered agree on amount and unit (the two fields that size the order in code),
 * and did they match the label? Models that did not run or whose run failed show as null and do not count.
 */
export function compareAgreement(
  cases: EvalCase[],
  models: { id: string; runs: EvalRun[] }[]
): Pick<EvalResults, 'agreement' | 'agreementSummary'> {
  const agreement: EvalAgreement[] = cases.map((c) => {
    const answers: EvalAgreement['answers'] = {};
    for (const m of models) {
      const out = m.runs.find((r) => r.caseId === c.id)?.output;
      answers[m.id] = out ? [out.amount, out.amountUnit] : null;
    }
    const given = Object.entries(answers).flatMap(([id, a]) => (a ? [[id, a] as const] : []));
    const key = (a: readonly [number, string]) => `${a[0]} ${a[1]}`;
    return {
      caseId: c.id,
      text: c.text,
      answers,
      agree: given.length < 2 ? null : new Set(given.map(([, a]) => key(a))).size === 1,
      expected: [c.expected.amount, c.expected.amountUnit],
      wrong: given.filter(([, a]) => key(a) !== key([c.expected.amount, c.expected.amountUnit])).map(([id]) => id),
    };
  });
  const comparable = agreement.filter((a) => a.agree !== null);
  return {
    agreement,
    agreementSummary: {
      comparable: comparable.length,
      agreed: comparable.filter((a) => a.agree).length,
      allCorrect: comparable.filter((a) => a.wrong.length === 0).length,
    },
  };
}
