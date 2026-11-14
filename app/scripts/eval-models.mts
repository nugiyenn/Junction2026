// Runs every hand-labelled request in eval/requests.json through each model with the real request-reading
// prompt and schema, and writes eval/results.json. A model whose key is missing is recorded as not run.
//
//   node --conditions=react-server --env-file=.env.local scripts/eval-models.mts
//   node --conditions=react-server --env-file=.env.local scripts/eval-models.mts --only=nemotron
//
// --only=<id> reruns one model and keeps the others' results from the existing file (use it once the
// Nemotron key is set, so Gemma's and Qwen's quota is not spent again).
import { readFileSync, writeFileSync } from 'node:fs';
import { classifyError, compareAgreement, scoreOutput, summarizeRuns } from '../src/lib/eval-score.ts';
import { interpretInstructions, PurchaseRequestSchema } from '../src/lib/interpret.ts';
import { EVAL_MODELS, missingEnv, runNamedModelStructured } from '../src/lib/llm.ts';
import type { EvalCase, EvalModelResult, EvalResults, EvalRun } from '../src/types/index.ts';

const TIMEOUT_MS = 60_000;
const REQUESTS = new URL('../eval/requests.json', import.meta.url);
const RESULTS = new URL('../eval/results.json', import.meta.url);

const { today, cases } = JSON.parse(readFileSync(REQUESTS, 'utf8')) as { today: { date: string; weekday: string }; cases: EvalCase[] };
const instructions = interpretInstructions(today);
const only = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length);
if (only && !EVAL_MODELS.some((m) => m.id === only)) throw new Error(`Unknown model "${only}". Known: ${EVAL_MODELS.map((m) => m.id).join(', ')}`);

async function runModel(model: (typeof EVAL_MODELS)[number]): Promise<EvalModelResult> {
  const base = { id: model.id, label: model.label, modelId: model.modelId(), ranAt: new Date().toISOString() };
  const missing = missingEnv(model.id);
  if (missing.length > 0) {
    console.log(`${model.id}: not run, ${missing.join(' and ')} missing`);
    return { ...base, status: 'not_run', reason: `${missing.join(' and ')} missing`, summary: null, runs: [] };
  }

  const runs: EvalRun[] = [];
  for (const c of cases) {
    const started = Date.now();
    try {
      const output = await runNamedModelStructured(model.id, instructions, c.text, PurchaseRequestSchema, { timeoutMs: TIMEOUT_MS });
      runs.push({ caseId: c.id, ok: true, latencyMs: Date.now() - started, output, error: null, errorKind: null, correct: scoreOutput(c.expected, output) });
    } catch (err) {
      runs.push({
        caseId: c.id,
        ok: false,
        latencyMs: Date.now() - started,
        output: null,
        error: (err as Error).message.slice(0, 300),
        errorKind: classifyError(err),
        correct: null,
      });
    }
    const last = runs[runs.length - 1];
    console.log(`${model.id} ${c.id}: ${last.ok ? 'ok' : `FAILED (${last.errorKind})`} ${last.latencyMs} ms`);
  }
  return { ...base, status: 'ran', reason: null, summary: summarizeRuns(runs), runs };
}

const previous: EvalResults | null = only ? JSON.parse(readFileSync(RESULTS, 'utf8')) : null;
const selected = EVAL_MODELS.filter((m) => !only || m.id === only);
// Models run side by side (they hit different providers; Gemma and Gemini share one key but separate quotas), each in order.
const fresh = await Promise.all(selected.map(runModel));
const models = EVAL_MODELS.map((m) => fresh.find((r) => r.id === m.id) ?? previous?.models.find((r) => r.id === m.id)).filter((r): r is EvalModelResult => !!r);

const results: EvalResults = {
  generatedAt: new Date().toISOString(),
  today: today.date,
  caseCount: cases.length,
  models,
  ...compareAgreement(cases, models),
};
writeFileSync(RESULTS, JSON.stringify(results, null, 2) + '\n');
console.log(`wrote eval/results.json (${models.length} models, ${cases.length} cases)`);
