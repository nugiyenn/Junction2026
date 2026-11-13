import { z } from 'zod';

// A minimal, stateless MCP server over Streamable HTTP: JSON-RPC 2.0 requests in, JSON responses out. It implements
// initialize, ping, tools/list and tools/call, which is all an agent needs to use Valio's gateway. Pure: tools are
// passed in, so the dispatcher is tested without a database.

export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export interface McpTool {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  /** True for tools that only read. */
  readOnly: boolean;
  run: (args: never) => Promise<unknown>;
}

interface RpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export type RpcResponse =
  | { jsonrpc: '2.0'; id: string | number | null; result: unknown }
  | { jsonrpc: '2.0'; id: string | number | null; error: { code: number; message: string; data?: unknown } };

const rpcError = (id: RpcRequest['id'], code: number, message: string): RpcResponse => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

export interface McpServerInfo {
  name: string;
  version: string;
  instructions: string;
}

/** Answers one JSON-RPC message. Returns null for notifications, which get no response. */
export async function handleRpc(message: unknown, tools: McpTool[], info: McpServerInfo): Promise<RpcResponse | null> {
  if (typeof message !== 'object' || message === null || (message as RpcRequest).jsonrpc !== '2.0' || typeof (message as RpcRequest).method !== 'string') {
    return rpcError(null, -32600, 'Invalid request: expected a JSON-RPC 2.0 message.');
  }
  const { id, method, params = {} } = message as RpcRequest;
  const isNotification = id === undefined;

  if (method.startsWith('notifications/')) return null;
  if (isNotification) return null;

  switch (method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return {
        jsonrpc: '2.0',
        id: id ?? null,
        result: {
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(asked) ? asked : SUPPORTED_PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: info.name, version: info.version },
          instructions: info.instructions,
        },
      };
    }

    case 'ping':
      return { jsonrpc: '2.0', id: id ?? null, result: {} };

    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id: id ?? null,
        result: {
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: z.toJSONSchema(t.inputSchema, { io: 'input' }),
            annotations: { readOnlyHint: t.readOnly, destructiveHint: false },
          })),
        },
      };

    case 'tools/call': {
      const tool = tools.find((t) => t.name === params.name);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${String(params.name)}`);

      const parsed = tool.inputSchema.safeParse(params.arguments ?? {});
      if (!parsed.success) {
        const problems = parsed.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; ');
        return { jsonrpc: '2.0', id: id ?? null, result: { isError: true, content: [{ type: 'text', text: `Invalid arguments. ${problems}` }] } };
      }
      try {
        const result = await tool.run(parsed.data as never);
        return {
          jsonrpc: '2.0',
          id: id ?? null,
          result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: false },
        };
      } catch (err) {
        // A tool failing is a result the agent can read and act on, not a protocol error.
        return { jsonrpc: '2.0', id: id ?? null, result: { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] } };
      }
    }

    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/** Handles a request body that is one message or an array of them. Returns null when nothing needs a response. */
export async function handleRpcBody(body: unknown, tools: McpTool[], info: McpServerInfo): Promise<RpcResponse | RpcResponse[] | null> {
  if (Array.isArray(body)) {
    const answers = (await Promise.all(body.map((m) => handleRpc(m, tools, info)))).filter((a): a is RpcResponse => a !== null);
    return answers.length ? answers : null;
  }
  return handleRpc(body, tools, info);
}
