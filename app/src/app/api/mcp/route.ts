import { handleRpcBody } from '@/lib/mcp';
import { MCP_INFO, MCP_TOOLS } from '@/lib/mcp-tools';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/**
 * POST /api/mcp — the gateway as an MCP server (Streamable HTTP, stateless, JSON responses).
 * Tools: search_products, request_offers, create_quote, place_order, get_order_status, verify_product, get_mandate.
 * There is no approve tool: approval stays with a human.
 *
 * Connect from Claude Code:  claude mcp add --transport http valio-aimo http://localhost:3000/api/mcp
 */
export async function POST(request: Request) {
  // Refuse browser requests from other origins: a web page must not be able to drive an agent's gateway session.
  const origin = request.headers.get('origin');
  let originHost: string | null = null;
  if (origin) {
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = ''; // "null" or garbage: not our origin
    }
  }
  if (origin && originHost !== new URL(request.url).host) {
    return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Origin not allowed.' } }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: the body is not JSON.' } }, { status: 400 });
  }

  let answer;
  try {
    answer = await handleRpcBody(body, MCP_TOOLS, MCP_INFO);
  } catch (err) {
    // Tool errors are answered inside handleRpcBody; this only catches something unexpected, so the client still gets JSON-RPC.
    console.error('MCP handler error:', err instanceof Error ? err.message : err);
    return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error.' } }, { status: 500 });
  }
  if (answer === null) return new Response(null, { status: 202 }); // notifications only
  return new Response(JSON.stringify(answer), { status: 200, headers: JSON_HEADERS });
}

/** No server-initiated stream and no sessions: this gateway is stateless. */
export function GET() {
  return new Response('This MCP endpoint is stateless: POST JSON-RPC messages to it.', { status: 405, headers: { Allow: 'POST' } });
}
