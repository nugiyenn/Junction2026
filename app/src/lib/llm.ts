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

  const raw = completion.choices[0]?.message?.content;
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

  const raw = completion.choices[0]?.message?.content;
  if (!raw) throw new Error('Empty response from Gemini');
  return schema.parse(JSON.parse(raw));
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
    temperature: 0.1,
    messages: [
      { role: 'system', content: `${systemPrompt}\nReturn ONLY raw JSON without markdown fences.` },
      { role: 'user', content: userPrompt },
    ],
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) throw new Error('Empty response from Featherless');
  const cleaned = raw.replace(/```json|```/g, '').trim();
  return schema.parse(JSON.parse(cleaned));
}
