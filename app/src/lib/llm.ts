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

  const client = new OpenAI({ apiKey, baseURL });
  clients.set(provider, client);
  return client;
}

/**
 * Generates 1536-dim embeddings via Gemini to match Aiven pgvector columns
 */
export async function embedText(text: string): Promise<number[]> {
  const res = await getClient('gemini').embeddings.create({
    model: 'gemini-embedding-001',
    input: text,
    dimensions: 1536,
  });
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
  model = 'gemini-3.8-flash'
): Promise<z.output<S>> {
  const completion = await getClient('gemini').chat.completions.create({
    model,
    temperature: 0.1,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: `${systemPrompt}\nRespond ONLY with valid JSON.` },
      { role: 'user', content: userPrompt },
    ],
  });

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

/** Gemma answers in about 5 s when Google is quiet and 40 s or more when it is busy. */
const GEMMA_DEADLINE_MS = 25_000;
/** After Gemma fails, go straight to Featherless for this long, so one slow spell costs one wait, not one per call. */
const GEMMA_SKIP_MS = 120_000;
let gemmaSkipUntil = 0;

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
  options: { gemmaDeadlineMs?: number } = {}
): Promise<{ output: z.output<S>; model: string }> {
  const deadline = options.gemmaDeadlineMs ?? GEMMA_DEADLINE_MS;

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
  if (Date.now() < gemmaSkipUntil) {
    reason = 'skipped after a recent failure';
  } else {
    try {
      return {
        output: await runGemmaStructured(instructions, input, schema, undefined, deadline),
        model: 'Gemma 4 (Google)',
      };
    } catch (gemmaError) {
      reason = /timed out|timeout/i.test((gemmaError as Error).message) ? `no answer within ${deadline / 1000}s` : 'failed';
      gemmaSkipUntil = Date.now() + GEMMA_SKIP_MS;
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
  model = 'Qwen/Qwen2.5-72B-Instruct'
): Promise<z.output<S>> {
  const completion = await getClient('featherless').chat.completions.create({
    model,
    temperature: 0, // 0.1 gave empty or degenerate replies on long inputs
    max_tokens: 512, // Featherless rejects calls without it (the default is the whole context window); our JSON is small
    messages: [
      { role: 'system', content: `${systemPrompt}\nReturn ONLY raw JSON without markdown fences.` },
      { role: 'user', content: userPrompt },
    ],
  });

  const raw = completion.choices?.[0]?.message?.content;
  if (!raw) throw new Error(`Empty response from Featherless: ${JSON.stringify(completion).slice(0, 300)}`);
  const cleaned = raw.replace(/```json|```/g, '').trim();
  return schema.parse(JSON.parse(cleaned));
}
