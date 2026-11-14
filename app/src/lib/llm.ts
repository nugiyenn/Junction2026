import 'server-only';
import OpenAI from 'openai';
import type { z } from 'zod';

const PROVIDERS = {
  groq: { envKey: 'GROQ_API_KEY', baseURL: 'https://api.groq.com/openai/v1' },
  featherless: { envKey: 'FEATHERLESS_API_KEY', baseURL: 'https://api.featherless.ai/v1' },
  gemini: { envKey: 'GEMINI_API_KEY', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/' },
} as const;

type Provider = keyof typeof PROVIDERS;

const clients = new Map<Provider, OpenAI>();

/**
 * Creates the client on first use so a missing key only fails the call that needs it.
 */
function getClient(provider: Provider): OpenAI {
  const cached = clients.get(provider);
  if (cached) return cached;

  const { envKey, baseURL } = PROVIDERS[provider];
  const apiKey = process.env[envKey];
  if (!apiKey) throw new Error(`Missing ${envKey}: cannot call ${provider}`);

  // Default is 10 minutes and 2 retries, far past a request's budget: fail in a minute, retry once.
  const client = new OpenAI({ apiKey, baseURL, timeout: 60_000, maxRetries: 1 });
  clients.set(provider, client);
  return client;
}

/**
 * Generates 1536-dim embeddings via Gemini to match Aiven pgvector columns
 */
export async function embedText(text: string): Promise<number[]> {
  // Search falls back to keywords when this fails, so fail fast: a slow embedding call must not stall a request.
  const res = await getClient('gemini').embeddings.create(
    { model: 'gemini-embedding-001', input: text, dimensions: 1536 },
    { timeout: 8_000, maxRetries: 0 }
  );
  return res.data[0].embedding;
}

/**
 * Batch version of embedText (one API call) for seeding, to stay under free-tier rate limits
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  const res = await getClient('gemini').embeddings.create({
    model: 'gemini-embedding-001',
    input: texts,
    dimensions: 1536,
  });
  return [...res.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

/**
 * Primary sub-second reasoning & structured JSON output via Groq, validated against `schema`
 */
export async function runGroqStructured<S extends z.ZodType>(
  systemPrompt: string,
  userPrompt: string,
  schema: S,
  model = 'openai/gpt-oss-120b'
): Promise<z.output<S>> {
  const completion = await getClient('groq').chat.completions.create({
    model,
    temperature: 0.1,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: `${systemPrompt}\nRespond ONLY with valid JSON.` },
      { role: 'user', content: userPrompt },
    ],
  });

  const raw = completion.choices?.[0]?.message?.content;
  if (!raw) throw new Error('Empty response from Groq');
  return schema.parse(JSON.parse(raw));
}

/**
 * Large-context / JSON fallback via Gemini, validated against `schema`.
 * Not called automatically: the caller picks it and logs it as a 'gemini_fallback' step.
 */
export async function runGeminiStructured<S extends z.ZodType>(
  systemPrompt: string,
  userPrompt: string,
  schema: S,
  model = 'gemini-3.8-flash',
  timeoutMs?: number
): Promise<z.output<S>> {
  const completion = await getClient('gemini').chat.completions.create(
    {
      model,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: `${systemPrompt}\nRespond ONLY with valid JSON.` },
        { role: 'user', content: userPrompt },
      ],
    },
    timeoutMs ? { timeout: timeoutMs, maxRetries: 0 } : undefined
  );

  const raw = completion.choices?.[0]?.message?.content;
  if (!raw) throw new Error('Empty response from Gemini');
  return schema.parse(JSON.parse(raw));
}

/**
 * Open-weights Gemma via the Gemini API, validated against `schema`.
 * Gemma there takes no system role or JSON mode, so instructions go in the user turn and JSON is
 * extracted from the text after its <thought> block.
 * Default is the mixture-of-experts 26B model: about 5 s per call, against about 40 s for gemma-4-31b-it.
 */
export async function runGemmaStructured<S extends z.ZodType>(
  instructions: string,
  input: string,
  schema: S,
  model = 'gemma-4-26b-a4b-it',
  timeoutMs?: number
): Promise<z.output<S>> {
  const completion = await getClient('gemini').chat.completions.create(
    {
      model,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: `${instructions}\nReturn ONLY one raw JSON object, no markdown fences, no commentary.\n\nInput:\n${input}`,
        },
      ],
    },
    // With a deadline, fail fast instead of letting the client retry: the caller has a fallback.
    timeoutMs ? { timeout: timeoutMs, maxRetries: 0 } : undefined
  );

  const raw = completion.choices?.[0]?.message?.content;
  if (!raw) throw new Error(`Empty response from Gemma: ${JSON.stringify(completion).slice(0, 300)}`);
  const answer = raw.replace(/<thought>[\s\S]*?<\/thought>/g, '');
  const json = answer.slice(answer.indexOf('{'), answer.lastIndexOf('}') + 1);
  if (!json) throw new Error(`Gemma returned no JSON: ${raw.slice(0, 200)}`);
  return schema.parse(JSON.parse(json));
}

/**
 * Gemma took about 12 s per request-reading call in the evaluation (slowest 17 s) and the longer match-picking prompt takes
 * more, so give it room: the demo should show Gemma answering, not Featherless. On the free tier a busy spell can still run
 * past this, and then Featherless answers and the label says so.
 */
const GEMMA_DEADLINE_MS = 45_000;
/** After Gemma fails, go straight to Featherless for this long, so one slow spell costs one wait, not one per call. */
const GEMMA_SKIP_MS = 120_000;
/**
 * When Gemma fails the open-model chain skips it for a while. Tracked per scope: a long page-reading call that times out
 * must not make the next short request-reading call skip Gemma, which is the call that should show Gemma answering.
 */
const gemmaSkipUntil = new Map<string, number>();

/**
 * Open-weights extraction with a fallback: Gemma first, and if Gemini errors (it sometimes answers 500)
 * or Gemma's output fails the schema, the same prompt goes to Featherless. Both are open-weights models.
 * Set LLM_PRIMARY=featherless to reverse the order. Returns the model that actually answered, and which
 * one failed first, so the audit trail can say so.
 */
export async function runOpenModelStructured<S extends z.ZodType>(
  instructions: string,
  input: string,
  schema: S,
  options: { gemmaDeadlineMs?: number; skipScope?: string } = {}
): Promise<{ output: z.output<S>; model: string }> {
  const deadline = options.gemmaDeadlineMs ?? GEMMA_DEADLINE_MS;
  const scope = options.skipScope ?? 'default';

  // LLM_PRIMARY=featherless: Featherless (Qwen 72B) first, Gemma only if it fails. For building, when Gemma's
  // free tier is slow. Unset or anything else keeps the default: Gemma first. Read on every call.
  if (process.env.LLM_PRIMARY === 'featherless') {
    try {
      return { output: await runFeatherlessValidation(instructions, input, schema), model: 'Qwen 2.5 72B (Featherless, primary)' };
    } catch (featherlessError) {
      console.warn('Featherless failed, falling back to Gemma:', (featherlessError as Error).message.slice(0, 200));
      try {
        return {
          output: await runGemmaStructured(instructions, input, schema, undefined, deadline),
          model: 'Gemma 4 (Google, after Featherless failed)',
        };
      } catch (gemmaError) {
        throw new Error(
          `Both models failed. Featherless: ${(featherlessError as Error).message.slice(0, 200)} Gemma: ${(gemmaError as Error).message.slice(0, 200)}`
        );
      }
    }
  }

  let reason: string;
  if (Date.now() < (gemmaSkipUntil.get(scope) ?? 0)) {
    reason = 'skipped after a recent failure';
  } else {
    try {
      return {
        output: await runGemmaStructured(instructions, input, schema, undefined, deadline),
        model: 'Gemma 4 (Google)',
      };
    } catch (gemmaError) {
      reason = /timed out|timeout/i.test((gemmaError as Error).message) ? `no answer within ${deadline / 1000}s` : 'failed';
      gemmaSkipUntil.set(scope, Date.now() + GEMMA_SKIP_MS);
      console.warn(`Gemma ${reason}, falling back to Featherless:`, (gemmaError as Error).message.slice(0, 200));
    }
  }

  // If the 72B model returns nothing usable, the 32B model is a different enough path to be worth one try.
  try {
    const output = await runFeatherlessValidation(instructions, input, schema);
    return { output, model: `Qwen 2.5 72B (Featherless, Gemma ${reason})` };
  } catch (firstError) {
    console.warn('Featherless 72B failed, trying 32B:', (firstError as Error).message.slice(0, 200));
    const output = await runFeatherlessValidation(instructions, input, schema, 'Qwen/Qwen2.5-32B-Instruct');
    return { output, model: `Qwen 2.5 32B (Featherless, Gemma ${reason})` };
  }
}

/**
 * Secondary open-source validation/scoring via Featherless (sponsor prize eligibility), validated against `schema`
 */
export async function runFeatherlessValidation<S extends z.ZodType>(
  systemPrompt: string,
  userPrompt: string,
  schema: S,
  model = 'Qwen/Qwen2.5-72B-Instruct',
  timeoutMs?: number
): Promise<z.output<S>> {
  const completion = await getClient('featherless').chat.completions.create(
    {
      model,
      temperature: 0, // 0.1 gave empty or degenerate replies on long inputs
      max_tokens: 512, // Featherless rejects calls without it (the default is the whole context window); our JSON is small
      messages: [
        { role: 'system', content: `${systemPrompt}\nReturn ONLY raw JSON without markdown fences.` },
        { role: 'user', content: userPrompt },
      ],
    },
    // Never the client's default: a slow Featherless must cost 30 s, not minutes, before the next model is tried.
    { timeout: timeoutMs ?? 30_000, maxRetries: 0 }
  );

  const raw = completion.choices?.[0]?.message?.content;
  if (!raw) throw new Error(`Empty response from Featherless: ${JSON.stringify(completion).slice(0, 300)}`);
  const cleaned = raw.replace(/```json|```/g, '').trim();
  return schema.parse(JSON.parse(cleaned));
}

// ---------------------------------------------------------------------------
// NVIDIA Nemotron, a model-by-name runner for the evaluation, and Nemotron-first page extraction
// ---------------------------------------------------------------------------

const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';
const NEMOTRON_RETRY_DELAYS_MS = [1_000, 2_000, 4_000];
/**
 * Nemotron 3.5 Super VL on build.nvidia.com (early-access free endpoint). The page's sample code leaves the model
 * field blank, so this id is inferred from the model's URL slug: confirm it once a key exists. NEMOTRON_MODEL overrides it.
 */
const DEFAULT_NEMOTRON_MODEL = 'nvidia/nemotron-3.5-super-vl-120b-a12b';
const nemotronModelId = () => process.env.NEMOTRON_MODEL || DEFAULT_NEMOTRON_MODEL;

export interface NemotronOptions {
  timeoutMs?: number;
  maxTokens?: number;
  /** A data URL (image/jpeg, png or webp): the user turn then carries it as an image part after the text. */
  imageUrl?: string;
  /** Test seams: a mocked transport and a sleep that does not wait. */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** Takes the JSON object out of a model's text (dropping reasoning blocks and fences) and validates it. */
function parseJsonAnswer<S extends z.ZodType>(raw: string, schema: S, label: string): z.output<S> {
  const answer = raw.replace(/<(thought|think)>[\s\S]*?<\/\1>/g, '').replace(/```json|```/g, '');
  const json = answer.slice(answer.indexOf('{'), answer.lastIndexOf('}') + 1);
  if (!json) throw new Error(`${label} returned no JSON: ${raw.slice(0, 200)}`);
  return schema.parse(JSON.parse(json));
}

/**
 * Nemotron via NVIDIA's OpenAI-compatible endpoint (build.nvidia.com), validated against `schema`.
 * The model id is NEMOTRON_MODEL, or the default above if unset.
 * The free tier allows about 40 requests a minute, so HTTP 429 and 5xx are retried with backoff (and
 * Retry-After); a timeout is not retried, because the caller has its own deadline.
 */
export async function runNemotronStructured<S extends z.ZodType>(
  instructions: string,
  input: string,
  schema: S,
  options: NemotronOptions = {}
): Promise<z.output<S>> {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) throw new Error('Missing NVIDIA_API_KEY: cannot call nemotron');
  const model = nemotronModelId();
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = options.timeoutMs ?? 60_000;

  const body = JSON.stringify({
    model,
    temperature: 0,
    max_tokens: options.maxTokens ?? 1024,
    // Reasoning off: we want the JSON, not a chain of thought, and it keeps latency down.
    chat_template_kwargs: { enable_thinking: false },
    // JSON mode: long pages make the model quote text, and an unescaped quote broke the JSON in a live run.
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: `${instructions}\nReturn ONLY one raw JSON object, no markdown fences, no commentary.` },
      {
        role: 'user',
        content: options.imageUrl
          ? [{ type: 'text', text: input }, { type: 'image_url', image_url: { url: options.imageUrl } }]
          : input,
      },
    ],
  });

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await doFetch(`${NVIDIA_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if ((err as Error).name === 'TimeoutError' || (err as Error).name === 'AbortError') {
        throw new Error(`Nemotron timed out after ${timeoutMs / 1000}s`);
      }
      if (attempt >= NEMOTRON_RETRY_DELAYS_MS.length) throw new Error(`Nemotron network error: ${(err as Error).message}`);
      await sleep(NEMOTRON_RETRY_DELAYS_MS[attempt]);
      continue;
    }

    if (res.status === 429 || res.status >= 500) {
      if (attempt >= NEMOTRON_RETRY_DELAYS_MS.length) throw new Error(`Nemotron HTTP ${res.status} after ${attempt + 1} attempts`);
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(retryAfter > 0 ? Math.min(retryAfter * 1000, 30_000) : NEMOTRON_RETRY_DELAYS_MS[attempt]);
      continue;
    }
    if (!res.ok) throw new Error(`Nemotron HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);

    const completion = (await res.json()) as { choices?: { message?: { content?: string | null } }[] };
    const raw = completion.choices?.[0]?.message?.content;
    if (!raw) throw new Error(`Empty response from Nemotron: ${JSON.stringify(completion).slice(0, 300)}`);
    return parseJsonAnswer(raw, schema, 'Nemotron');
  }
}

/**
 * Nemotron reading an image (a data URL), validated against `schema`: the vision side of the same model.
 * Same retries and JSON mode as runNemotronStructured; 40 s deadline. `model` is the id the call was sent to.
 */
export async function runNemotronVision<S extends z.ZodType>(
  instructions: string,
  prompt: string,
  imageUrl: string,
  schema: S,
  options: Omit<NemotronOptions, 'imageUrl'> = {}
): Promise<{ output: z.output<S>; model: string }> {
  const output = await runNemotronStructured(instructions, prompt, schema, { timeoutMs: 40_000, maxTokens: 1500, ...options, imageUrl });
  return { output, model: nemotronModelId() };
}

/** The models the evaluation compares, by id. `requires` lists the env names a model needs before it can be called. */
export const EVAL_MODELS = [
  { id: 'gemma-4', label: 'Gemma 4 26B', requires: ['GEMINI_API_KEY'], modelId: () => 'gemma-4-26b-a4b-it' },
  { id: 'qwen-2.5-72b', label: 'Qwen 2.5 72B (Featherless)', requires: ['FEATHERLESS_API_KEY'], modelId: () => 'Qwen/Qwen2.5-72B-Instruct' },
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', requires: ['GEMINI_API_KEY'], modelId: () => 'gemini-3.8-flash' },
  { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite', requires: ['GEMINI_API_KEY'], modelId: () => 'gemini-3.1-flash-lite' },
  { id: 'nemotron', label: 'Nemotron 3.5 Super VL', requires: ['NVIDIA_API_KEY'], modelId: nemotronModelId },
] as const;

export type EvalModelId = (typeof EVAL_MODELS)[number]['id'];

/** Env names a model still needs, empty when it can be called. */
export function missingEnv(modelName: EvalModelId): string[] {
  const model = EVAL_MODELS.find((m) => m.id === modelName);
  if (!model) throw new Error(`Unknown model ${modelName}`);
  return model.requires.filter((name) => !process.env[name]);
}

/**
 * One call to one named model, with the same prompt and schema whichever model it is, so the
 * evaluation compares models and not plumbing. No fallback: a failure is the model's result.
 */
export async function runNamedModelStructured<S extends z.ZodType>(
  modelName: EvalModelId,
  instructions: string,
  input: string,
  schema: S,
  options: { timeoutMs?: number } = {}
): Promise<z.output<S>> {
  const { timeoutMs } = options;
  switch (modelName) {
    case 'gemma-4':
      return runGemmaStructured(instructions, input, schema, undefined, timeoutMs);
    case 'qwen-2.5-72b':
      return runFeatherlessValidation(instructions, input, schema, undefined, timeoutMs);
    case 'gemini-3.8-flash':
      return runGeminiStructured(instructions, input, schema, undefined, timeoutMs);
    case 'gemini-3.1-flash-lite':
      return runGeminiStructured(instructions, input, schema, 'gemini-3.1-flash-lite', timeoutMs);
    case 'nemotron':
      return runNemotronStructured(instructions, input, schema, { timeoutMs });
    default:
      throw new Error(`Unknown model ${modelName satisfies never}`);
  }
}

/**
 * Long page-reading extraction: Nemotron first when NVIDIA_API_KEY is set, otherwise (or if it fails) the
 * open-model chain of runOpenModelStructured. Same signature and result shape, so a caller can swap one for
 * the other. The returned `model` says who answered.
 */
export async function runExtractionModelStructured<S extends z.ZodType>(
  instructions: string,
  input: string,
  schema: S,
  options: { gemmaDeadlineMs?: number; skipScope?: string } = {}
): Promise<{ output: z.output<S>; model: string }> {
  if (!process.env.NVIDIA_API_KEY) return runOpenModelStructured(instructions, input, schema, options);
  let nemotronError: unknown;
  // One more try when the answer was not usable JSON (a different sampling often fixes it); not for timeouts or HTTP errors.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return { output: await runNemotronStructured(instructions, input, schema, { timeoutMs: 30_000, maxTokens: 2048 }), model: 'Nemotron (NVIDIA)' };
    } catch (err) {
      nemotronError = err;
      if (/timed out|HTTP|Missing|network/i.test((err as Error).message)) break;
    }
  }
  console.warn('Nemotron failed, falling back to the open-model chain:', (nemotronError as Error).message.slice(0, 200));
  const fallback = await runOpenModelStructured(instructions, input, schema, options);
  return { output: fallback.output, model: `${fallback.model}, after Nemotron failed` };
}
