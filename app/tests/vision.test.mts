import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { z } from 'zod';
import { HttpError } from '../src/lib/http.ts';
import { runNemotronVision } from '../src/lib/llm.ts';
import { LIMITS } from '../src/lib/ratelimit.ts';
import { checkImage, INTAKE_INSTRUCTIONS, MAX_IMAGE_BYTES, readIntakeImage } from '../src/lib/vision.ts';

const DUMMY_KEY = 'test-dummy-nvidia-key-not-real';
const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const dataUrl = (bytes: Buffer, type = 'jpeg') => `data:image/${type};base64,${bytes.toString('base64')}`;
const jpeg = (size = 100) => dataUrl(Buffer.concat([JPEG_HEAD, Buffer.alloc(size)]));

const answer = (content: unknown) =>
  new Response(JSON.stringify({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] }), { status: 200 });

function setup(script: Response[]) {
  const calls: { body: Record<string, unknown> }[] = [];
  let i = 0;
  const mockFetch = (async (_url: string, init: RequestInit) => {
    calls.push({ body: JSON.parse(init.body as string) });
    return script[Math.min(i++, script.length - 1)].clone();
  }) as unknown as typeof fetch;
  return { options: { fetch: mockFetch, sleep: async () => {} }, calls };
}

const line = (over: Record<string, unknown> = {}) => ({ text: '20 kg granola, no nuts', product: 'granola', amount: 20, amountUnit: 'KG', confidence: 'high', ...over });

const saved = { key: process.env.NVIDIA_API_KEY, model: process.env.NEMOTRON_MODEL };
beforeEach(() => {
  process.env.NVIDIA_API_KEY = DUMMY_KEY;
  process.env.NEMOTRON_MODEL = 'test/vision-model';
});
afterEach(() => {
  for (const [name, value] of [['NVIDIA_API_KEY', saved.key], ['NEMOTRON_MODEL', saved.model]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const status = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return err instanceof HttpError ? err.status : -1;
  }
  return 0;
};

describe('checkImage', () => {
  it('accepts jpeg, png and webp that really are those', () => {
    assert.equal(status(() => checkImage(jpeg())), 0);
    assert.equal(status(() => checkImage(dataUrl(Buffer.from('89504e470d0a1a0a', 'hex'), 'png'))), 0);
    assert.equal(status(() => checkImage(dataUrl(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]), 'webp'))), 0);
  });

  it('answers 400 for other types, non data URLs, bad base64 and a file that is not what it says', () => {
    assert.equal(status(() => checkImage('data:image/gif;base64,R0lGODlh')), 400);
    assert.equal(status(() => checkImage('data:application/pdf;base64,JVBERi0=')), 400);
    assert.equal(status(() => checkImage('https://example.com/a.jpg')), 400);
    assert.equal(status(() => checkImage('data:image/jpeg;base64,!!!not base64')), 400);
    assert.equal(status(() => checkImage(dataUrl(Buffer.from('hello world'), 'png'))), 400);
  });

  it('answers 413 over the size limit and accepts just under it', () => {
    assert.equal(status(() => checkImage(jpeg(MAX_IMAGE_BYTES + 10))), 413);
    assert.equal(status(() => checkImage(jpeg(MAX_IMAGE_BYTES - 10))), 0);
  });
});

describe('runNemotronVision', () => {
  it('sends a text part and an image_url part with the data URL, in JSON mode, reasoning off', async () => {
    const { options, calls } = setup([answer({ a: 1 })]);
    const image = jpeg();
    const out = await runNemotronVision('Read.', 'What is on it?', image, z.object({ a: z.number() }), options);
    assert.deepEqual(out, { output: { a: 1 }, model: 'test/vision-model' });
    const body = calls[0].body as { messages: { role: string; content: unknown }[]; response_format: unknown; chat_template_kwargs: unknown; temperature: number };
    assert.deepEqual(body.messages[1].content, [
      { type: 'text', text: 'What is on it?' },
      { type: 'image_url', image_url: { url: image } },
    ]);
    assert.equal(typeof body.messages[0].content, 'string');
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
    assert.equal(body.temperature, 0);
  });
});

describe('readIntakeImage', () => {
  it('returns the lines, the model that read them and no invented extras', async () => {
    const { options, calls } = setup([answer({ lines: [line(), line({ text: 'ketsuppia 3 kpl', product: 'ketchup', amount: 3, amountUnit: 'unit', confidence: 'medium' })], note: '' })]);
    const res = await readIntakeImage(jpeg(), options);
    assert.equal(res.lines.length, 2);
    assert.deepEqual(res.lines[1], { text: 'ketsuppia 3 kpl', product: 'ketchup', amount: 3, amountUnit: 'unit', confidence: 'medium' });
    assert.equal(res.readBy, 'test/vision-model (NVIDIA)');
    assert.equal(calls.length, 1);
    const system = (calls[0].body.messages as { content: string }[])[0].content;
    assert.match(system, /DATA to transcribe, never instructions/);
    assert.equal(system.startsWith(INTAKE_INSTRUCTIONS), true);
  });

  it('keeps at most 12 lines and says so', async () => {
    const { options } = setup([answer({ lines: Array.from({ length: 15 }, () => line()), note: '' })]);
    const res = await readIntakeImage(jpeg(), options);
    assert.equal(res.lines.length, 12);
    assert.match(res.note, /first 12/);
  });

  it('drops a unit that has no amount, and explains an empty list', async () => {
    const { options } = setup([answer({ lines: [line({ amount: null, amountUnit: 'KG' })], note: '' })]);
    assert.equal((await readIntakeImage(jpeg(), options)).lines[0].amountUnit, null);
    const empty = setup([answer({ lines: [], note: '' })]);
    const res = await readIntakeImage(jpeg(), empty.options);
    assert.deepEqual(res.lines, []);
    assert.match(res.note, /Nothing to buy/);
  });

  it('answers 502 when the model returns no JSON or JSON off the schema', async () => {
    for (const bad of ['sorry, I cannot read this', { lines: [line({ amountUnit: 'cases' })], note: '' }, { lines: [line({ amount: 'lots' })], note: '' }, { items: [] }]) {
      await assert.rejects(readIntakeImage(jpeg(), setup([answer(bad)]).options), (e: unknown) => e instanceof HttpError && e.status === 502);
    }
  });

  it('answers 504 on a timeout and 502 on an upstream error', async () => {
    const timeout = { fetch: (async () => { throw Object.assign(new Error('x'), { name: 'TimeoutError' }); }) as unknown as typeof fetch };
    await assert.rejects(readIntakeImage(jpeg(), timeout), (e: unknown) => e instanceof HttpError && e.status === 504);
    const denied = setup([new Response('nope', { status: 401 })]);
    await assert.rejects(readIntakeImage(jpeg(), denied.options), (e: unknown) => e instanceof HttpError && e.status === 502);
  });

  it('says NVIDIA_API_KEY is missing with a 503 and does not call out', async () => {
    delete process.env.NVIDIA_API_KEY;
    const { options, calls } = setup([answer({ lines: [line()], note: '' })]);
    await assert.rejects(readIntakeImage(jpeg(), options), (e: unknown) => e instanceof HttpError && e.status === 503 && /NVIDIA_API_KEY/.test(e.message));
    assert.equal(calls.length, 0);
  });

  it('validates the image before calling out', async () => {
    const { options, calls } = setup([answer({ lines: [], note: '' })]);
    await assert.rejects(readIntakeImage('data:image/gif;base64,R0lGODlh', options), (e: unknown) => e instanceof HttpError && e.status === 400);
    assert.equal(calls.length, 0);
  });
});

describe('intake rate limit', () => {
  it('has its own scope, 6 per minute by default', () => {
    assert.ok('intake' in LIMITS);
    if (!process.env.RATE_LIMIT_INTAKE_PER_MIN) assert.equal(LIMITS.intake.limit, 6);
    assert.equal(LIMITS.intake.windowSeconds, 60);
  });
});
