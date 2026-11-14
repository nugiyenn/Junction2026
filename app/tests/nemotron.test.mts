import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { z } from 'zod';
import { missingEnv, runExtractionModelStructured, runNemotronStructured } from '../src/lib/llm.ts';

// Tests use keys of their own, so a failing assertion can only ever print these.
const DUMMY_KEY = 'test-dummy-nvidia-key-not-real';
const Schema = z.object({ amount: z.number() });

const reply = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
const status = (code: number, headers: Record<string, string> = {}) => new Response('nope', { status: code, headers });

function setup(script: (Response | Error)[]) {
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const sleeps: number[] = [];
  let i = 0;
  const mockFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) });
    const next = script[Math.min(i++, script.length - 1)];
    if (next instanceof Error) throw next;
    return next.clone();
  }) as unknown as typeof fetch;
  return { options: { fetch: mockFetch, sleep: async (ms: number) => void sleeps.push(ms) }, calls, sleeps };
}

const saved = { key: process.env.NVIDIA_API_KEY, model: process.env.NEMOTRON_MODEL };
beforeEach(() => {
  process.env.NVIDIA_API_KEY = DUMMY_KEY;
  process.env.NEMOTRON_MODEL = 'test/model-id';
});
afterEach(() => {
  for (const [name, value] of [['NVIDIA_API_KEY', saved.key], ['NEMOTRON_MODEL', saved.model]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('runNemotronStructured', () => {
  it('sends an OpenAI-style chat request to NVIDIA with the configured model and parses the JSON', async () => {
    const { options, calls } = setup([reply('<think>hmm</think>```json\n{"amount": 5}\n```')]);
    assert.deepEqual(await runNemotronStructured('Read it.', 'five', Schema, options), { amount: 5 });
    assert.equal(calls[0].url, 'https://integrate.api.nvidia.com/v1/chat/completions');
    assert.equal(calls[0].headers.Authorization, `Bearer ${DUMMY_KEY}`);
    assert.equal(calls[0].body.model, 'test/model-id');
    assert.equal(calls[0].body.temperature, 0);
  });

  it('retries 429 and 5xx with backoff, honouring Retry-After', async () => {
    const { options, calls, sleeps } = setup([status(429, { 'retry-after': '3' }), status(503), reply('{"amount": 1}')]);
    assert.deepEqual(await runNemotronStructured('x', 'y', Schema, options), { amount: 1 });
    assert.equal(calls.length, 3);
    assert.deepEqual(sleeps, [3000, 2000]);
  });

  it('gives up after the retries and says so', async () => {
    const { options, calls } = setup([status(429)]);
    await assert.rejects(runNemotronStructured('x', 'y', Schema, options), /HTTP 429 after 4 attempts/);
    assert.equal(calls.length, 4);
  });

  it('does not retry a client error such as a bad key', async () => {
    const { options, calls } = setup([status(401)]);
    await assert.rejects(runNemotronStructured('x', 'y', Schema, options), /HTTP 401/);
    assert.equal(calls.length, 1);
  });

  it('does not retry a timeout', async () => {
    const { options, calls } = setup([Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' })]);
    await assert.rejects(runNemotronStructured('x', 'y', Schema, { ...options, timeoutMs: 5000 }), /timed out after 5s/);
    assert.equal(calls.length, 1);
  });

  it('rejects output that fails the schema', async () => {
    const { options } = setup([reply('{"amount": "lots"}')]);
    await assert.rejects(runNemotronStructured('x', 'y', Schema, options));
  });

  it('names the missing env var and does not call out', async () => {
    const { options, calls } = setup([reply('{"amount": 1}')]);
    delete process.env.NVIDIA_API_KEY;
    await assert.rejects(runNemotronStructured('x', 'y', Schema, options), /Missing NVIDIA_API_KEY: cannot call nemotron/);
    assert.equal(calls.length, 0);
  });

  it('uses the default model id when NEMOTRON_MODEL is unset', async () => {
    delete process.env.NEMOTRON_MODEL;
    const { options, calls } = setup([reply('{"amount": 1}')]);
    await runNemotronStructured('x', 'y', Schema, options);
    assert.equal(calls[0].body.model, 'nvidia/nemotron-3.5-super-vl-120b-a12b');
  });
});

describe('missingEnv', () => {
  it('lists what a model still needs', () => {
    assert.deepEqual(missingEnv('nemotron'), []);
    delete process.env.NVIDIA_API_KEY;
    assert.deepEqual(missingEnv('nemotron'), ['NVIDIA_API_KEY']);
  });
});

describe('runExtractionModelStructured', () => {
  it('without NVIDIA_API_KEY it goes to the open-model chain, not Nemotron', async () => {
    delete process.env.NVIDIA_API_KEY;
    const savedGemini = process.env.GEMINI_API_KEY;
    const savedFeatherless = process.env.FEATHERLESS_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.FEATHERLESS_API_KEY;
    try {
      // The chain's own errors name its keys; Nemotron's would name NVIDIA_API_KEY.
      await assert.rejects(runExtractionModelStructured('x', 'y', Schema), /Missing FEATHERLESS_API_KEY/);
    } finally {
      if (savedGemini !== undefined) process.env.GEMINI_API_KEY = savedGemini;
      if (savedFeatherless !== undefined) process.env.FEATHERLESS_API_KEY = savedFeatherless;
    }
  });
});
