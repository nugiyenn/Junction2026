import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { handleRpc, handleRpcBody, type McpTool, type RpcResponse } from '../src/lib/mcp.ts';

const info = { name: 'test-gateway', version: '9.9.9', instructions: 'Use the tools.' };

const tools: McpTool[] = [
  {
    name: 'add',
    description: 'Adds two numbers.',
    inputSchema: z.object({ a: z.number(), b: z.number().default(1) }),
    readOnly: true,
    run: (async ({ a, b }: { a: number; b: number }) => ({ sum: a + b })) as McpTool['run'],
  },
  {
    name: 'boom',
    description: 'Always fails.',
    inputSchema: z.object({}),
    readOnly: false,
    run: (async () => {
      throw new Error('Quote expired at 12:00.');
    }) as McpTool['run'],
  },
];

const call = (method: string, params?: object, id: number | null = 1) => handleRpc({ jsonrpc: '2.0', id, method, params }, tools, info) as Promise<RpcResponse>;
const result = (r: RpcResponse) => (r as { result: Record<string, unknown> }).result;
const error = (r: RpcResponse) => (r as { error: { code: number; message: string } }).error;

describe('initialize', () => {
  it('answers with the negotiated version, tool capability, server info and instructions', async () => {
    const r = result(await call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'c', version: '1' } }));
    assert.equal(r.protocolVersion, '2025-03-26');
    assert.deepEqual(r.capabilities, { tools: { listChanged: false } });
    assert.deepEqual(r.serverInfo, { name: 'test-gateway', version: '9.9.9' });
    assert.equal(r.instructions, 'Use the tools.');
  });
  it('offers its newest version when the client asks for one it does not know', async () => {
    assert.equal(result(await call('initialize', { protocolVersion: '1999-01-01' })).protocolVersion, '2025-06-18');
  });
});

describe('tools/list', () => {
  it('lists every tool with a JSON Schema and a read-only hint', async () => {
    const list = result(await call('tools/list')).tools as { name: string; inputSchema: { properties: object; required?: string[] }; annotations: { readOnlyHint: boolean } }[];
    assert.deepEqual(list.map((t) => t.name), ['add', 'boom']);
    assert.deepEqual(Object.keys(list[0].inputSchema.properties), ['a', 'b']);
    assert.deepEqual(list[0].inputSchema.required, ['a']);
    assert.equal(list[0].annotations.readOnlyHint, true);
    assert.equal(list[1].annotations.readOnlyHint, false);
  });
});

describe('tools/call', () => {
  it('runs a tool and returns text plus structured content', async () => {
    const r = result(await call('tools/call', { name: 'add', arguments: { a: 2 } }));
    assert.equal(r.isError, false);
    assert.deepEqual(r.structuredContent, { sum: 3 });
    assert.match((r.content as { text: string }[])[0].text, /"sum": 3/);
  });
  it('reports invalid arguments as a tool error the agent can read, naming the field', async () => {
    const r = result(await call('tools/call', { name: 'add', arguments: { a: 'two' } }));
    assert.equal(r.isError, true);
    assert.match((r.content as { text: string }[])[0].text, /a: /);
  });
  it('reports a failing tool as a tool error with its message, not a protocol error', async () => {
    const r = result(await call('tools/call', { name: 'boom', arguments: {} }));
    assert.equal(r.isError, true);
    assert.equal((r.content as { text: string }[])[0].text, 'Quote expired at 12:00.');
  });
  it('rejects an unknown tool as invalid params', async () => {
    assert.equal(error(await call('tools/call', { name: 'approve_order', arguments: {} })).code, -32602);
  });
});

describe('protocol edges', () => {
  it('answers ping', async () => {
    assert.deepEqual(result(await call('ping')), {});
  });
  it('gives notifications no response', async () => {
    assert.equal(await handleRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, tools, info), null);
    assert.equal(await handleRpc({ jsonrpc: '2.0', id: 5, method: 'notifications/cancelled' }, tools, info), null);
  });
  it('reports an unknown method', async () => {
    assert.equal(error(await call('resources/list')).code, -32601);
  });
  it('rejects a message that is not JSON-RPC 2.0', async () => {
    assert.equal(error((await handleRpc({ method: 'ping' }, tools, info)) as RpcResponse).code, -32600);
    assert.equal(error((await handleRpc('hello', tools, info)) as RpcResponse).code, -32600);
  });
  it('answers a batch with the responses that need one', async () => {
    const out = (await handleRpcBody(
      [
        { jsonrpc: '2.0', id: 1, method: 'ping' },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'ping' },
      ],
      tools,
      info
    )) as RpcResponse[];
    assert.deepEqual(out.map((o) => o.id), [1, 2]);
    assert.equal(await handleRpcBody([{ jsonrpc: '2.0', method: 'notifications/initialized' }], tools, info), null);
  });
});
