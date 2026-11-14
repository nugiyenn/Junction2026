// End-to-end check against a running dev server (default http://localhost:3000):
//   node scripts/e2e-local.mjs            (BASE=http://localhost:3010 to point elsewhere)
// It exercises the real services: auto-approval, escalation to a human, the MCP tools, idempotency, the data firewall,
// the audit chain and the live web checks. It writes real quotes, orders and audit events to the database
// (use "Reset demo data" afterwards) and spends model and web quota: about two full requests. Prints PASS/FAIL, never keys.

const BASE = process.env.BASE ?? 'http://localhost:3000';
const MINUTE = 60_000;
let failures = 0;

const log = (ok, name, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};

async function http(method, path, body, headers = {}, timeoutMs = 5 * MINUTE) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, headers: res.headers, json, text };
}

const mcp = async (id, method, params, headers = {}) =>
  http('POST', '/api/mcp', { jsonrpc: '2.0', id, method, params }, headers, 3 * MINUTE);

async function main() {
  console.log(`Target: ${BASE}\n`);

  // --- Infrastructure
  const health = await http('GET', '/api/health', undefined, {}, 30_000);
  log(health.status === 200, 'health route answers');
  for (const s of health.json?.services ?? []) log(s.ok === true || !s.configured, `service ${s.name}`, s.configured ? (s.ok ? 'reachable' : s.detail) : 'not configured (protections off)');

  const mandates = await http('GET', '/api/mandates', undefined, {}, 30_000);
  const ids = (mandates.json?.mandates ?? []).map((m) => m.id);
  log(ids.includes('demo-hotel') && ids.includes('demo-school'), 'demo mandates exist', ids.join(', '));

  // --- Error handling
  const bad = await http('POST', '/api/requests', '{not json', { 'Content-Type': 'application/json' }, 30_000);
  log(bad.status === 400 && typeof bad.json?.error === 'string', 'malformed JSON gets a clean 400', `HTTP ${bad.status}`);
  const unknown = await http('POST', '/api/requests', { mandateId: 'nope', text: 'I need 10 L of milk by Monday' }, {}, 60_000);
  log(unknown.status === 404, 'unknown mandate gets 404', `HTTP ${unknown.status}`);
  const noQuote = await http('POST', '/api/orders', { quoteId: '00000000-0000-4000-8000-000000000000' }, {}, 30_000);
  log(noQuote.status === 404, 'ordering an unknown quote gets 404', `HTTP ${noQuote.status}`);

  // --- 1. Auto-approval path (hotel, small order) with live web checks and the second opinion
  console.log('\nHotel, 100 L lactose-free milk (expected: auto-approved). This takes about a minute.');
  const small = await http('POST', '/api/requests', { mandateId: 'demo-hotel', text: 'I need 100 litres of lactose-free milk by Monday.' });
  log(small.status === 201, 'request answered', `HTTP ${small.status}${small.json?.error ? ' ' + small.json.error : ''}`);
  const r = small.json;
  if (r?.quote) {
    log(!!r.models?.interpreted, 'request read by a model', r.models.interpreted);
    log(['agree', 'disagree', 'unavailable'].includes(r.interpretationCheck?.status), 'second opinion present', `${r.interpretationCheck?.secondModel}: ${r.interpretationCheck?.status}`);
    log(Array.isArray(r.offers) && r.offers.length >= 1, 'offers built', `${r.offers.length} offer(s)`);
    // The rolling 24 h rule is part of the product: if earlier orders (earlier runs of this script) add up past the limit, a small order waits for a person.
    const rolling = (r.policy?.reasons ?? []).some((x) => /last 24 hours/i.test(x));
    log(r.policy?.outcome === 'auto_approve' || (r.policy?.outcome === 'needs_approval' && rolling), 'policy preview is auto-approve (or held by the rolling 24 h rule)', `${r.policy?.outcome}${rolling ? ' (rolling rule)' : ''}`);
    const checked = r.liveChecks?.products ?? [];
    log(checked.length > 0, 'live web checks ran (Oxylabs)', `${checked.length} product(s), ${checked.filter((p) => p.verification).length} verified, ${checked.filter((p) => p.recall).length} recall-checked`);
    const sourced = checked.some((p) => (p.verification?.sources ?? []).some((s) => s.url?.startsWith('http')));
    log(sourced, 'checks carry source URLs');
    const leaks = JSON.stringify(r.quote);
    log(!/"internal"|"listPrice"|"discountPct"|"vendorName"/.test(leaks), 'agent quote hides list price, discount and supplier');
    log(r.quote.lines.every((l) => l.stock && l.availableAmount === undefined), 'agent quote shows stock confidence, not amounts');

    const key = `e2e-${Date.now()}`;
    const first = await http('POST', '/api/orders', { quoteId: r.quote.id }, { 'Idempotency-Key': key }, 60_000);
    const firstStatus = first.json?.order?.status;
    log(first.status === 201 && (firstStatus === 'confirmed' || (firstStatus === 'pending_approval' && rolling)), 'small order confirmed without a human (or held by the rolling rule)', firstStatus ?? first.json?.error);
    const replay = await http('POST', '/api/orders', { quoteId: r.quote.id }, { 'Idempotency-Key': key }, 60_000);
    const valkeyOn = (health.json?.services ?? []).some((s) => s.name === 'valkey' && s.ok);
    if (valkeyOn) log(replay.status === 201 && replay.headers.get('idempotent-replayed') === 'true' && replay.json?.order?.id === first.json?.order?.id, 'retry with the same Idempotency-Key replays the order');
    const dup = await http('POST', '/api/orders', { quoteId: r.quote.id }, {}, 60_000);
    log(dup.status === 409, 'ordering the same quote twice is refused', `HTTP ${dup.status}`);
  }

  // --- 2. Escalation to a human (hotel, large order)
  console.log('\nHotel, 1,000 L lactose-free milk (expected: needs a person). This takes about a minute.');
  const big = await http('POST', '/api/requests', { mandateId: 'demo-hotel', text: 'I need 1,000 litres of lactose-free milk by Monday. Find an option that meets our requirements based on price and availability.' });
  log(big.status === 201 && !!big.json?.quote, 'large request answered', `HTTP ${big.status}${big.json?.error ? ' ' + big.json.error : ''}`);
  if (big.json?.quote) {
    log(big.json.policy?.outcome === 'needs_approval', 'policy preview needs a person', big.json.policy?.outcome);
    const placed = await http('POST', '/api/orders', { quoteId: big.json.quote.id }, {}, 60_000);
    const order = placed.json?.order;
    log(placed.status === 201 && order?.status === 'pending_approval', 'order waits for approval', order?.status ?? placed.json?.error);
    log((order?.policyReasons ?? []).length > 0, 'reasons are listed', (order?.policyReasons ?? [])[0]?.slice(0, 80));
    if (order?.id) {
      const decided = await http('POST', `/api/orders/${order.id}/decision`, { decision: 'approve', decidedBy: 'e2e script', note: 'automated check' }, {}, 60_000);
      log(decided.status === 200 && decided.json?.order?.status === 'confirmed', 'a person approves it', decided.json?.order?.status ?? decided.json?.error);
      const again = await http('POST', `/api/orders/${order.id}/decision`, { decision: 'approve', decidedBy: 'e2e script' }, {}, 60_000);
      log(again.status === 409, 'a decided order cannot be decided again', `HTTP ${again.status}`);
      // Receipt for the order a person just approved, and the pages that go with the new features.
      const receipt = await http('GET', `/api/orders/${order.id}/receipt`, undefined, {}, 60_000);
      log(receipt.status === 200 && receipt.json?.version === 1 && !!receipt.json?.signature, 'signed receipt for the approved order', `HTTP ${receipt.status}`);
      const leaks = JSON.stringify(receipt.json ?? {});
      log(!/"listPrice"|"discountPct"|"vendorName"|"availableAmount":\s*\d/.test(leaks), 'receipt hides list price, discount, supplier and exact stock');
      log((receipt.json?.audit?.events ?? []).length > 0, 'receipt carries the audit events', `${(receipt.json?.audit?.events ?? []).length} event(s), linked: ${receipt.json?.audit?.linked}`);
    }
  }

  // --- New surfaces
  console.log('\nNew features');
  const autonomy = await http('GET', '/api/autonomy?mandateId=demo-school', undefined, {}, 60_000);
  log(autonomy.status === 200 && Array.isArray(autonomy.json?.suggestions), 'earned-autonomy suggestions answer', `${(autonomy.json?.suggestions ?? []).length} suggestion(s)`);
  const redteam = await http('GET', '/api/redteam', undefined, {}, 30_000);
  log(redteam.status === 200 && (redteam.json?.scenarios ?? []).length >= 9, 'red-team scenarios listed', `${(redteam.json?.scenarios ?? []).length} scenarios`);
  const gif = await http('POST', '/api/intake', { image: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' }, {}, 30_000);
  log(gif.status === 400, 'photo intake refuses a non-image type before any model call', `HTTP ${gif.status}`);
  const stats = await http('GET', '/api/stats?mandateId=demo-hotel', undefined, {}, 60_000);
  log(stats.status === 200 && !!stats.json?.source, 'buyer stats answer', `source: ${stats.json?.source}`);
  const catalog = await http('GET', '/api/products/search?q=oat%20drink&limit=3', undefined, {}, 60_000);
  log(catalog.status === 200 && !/"vendorName"|"category"/.test(catalog.text), 'catalog search hides supplier and internal category');
  for (const page of ['/', '/approvals', '/exposure', '/audit', '/stats', '/autonomy', '/models', '/verify', '/red-team']) {
    const res = await fetch(BASE + page, { signal: AbortSignal.timeout(60_000) });
    log(res.status === 200, `page ${page} loads`, `HTTP ${res.status}`);
  }
  log(typeof health.json?.approverKeyRequired === 'boolean', 'health reports whether the approver key is required', String(health.json?.approverKeyRequired));

  // --- 3. MCP
  console.log('\nMCP');
  const init = await mcp(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } });
  log(init.status === 200 && !!init.json?.result?.serverInfo, 'MCP initialize', init.json?.result?.serverInfo?.name);
  const list = await mcp(2, 'tools/list', {});
  const tools = (list.json?.result?.tools ?? []).map((t) => t.name);
  log(tools.length === 7, 'seven tools listed', tools.join(', '));
  log(!tools.some((t) => /approve|decline|mandate_?(edit|update|set)/i.test(t)), 'no approve or mandate-editing tool exists');
  const mandate = await mcp(3, 'tools/call', { name: 'get_mandate', arguments: { mandateId: 'demo-school' } });
  log(!mandate.json?.result?.isError && /demo-school/.test(JSON.stringify(mandate.json?.result ?? '')), 'tool call: get_mandate');
  const search = await mcp(4, 'tools/call', { name: 'search_products', arguments: { query: 'oat drink', limit: 3 } });
  log(!search.json?.result?.isError && !!search.json?.result, 'tool call: search_products');
  const badOrder = await mcp(5, 'tools/call', { name: 'place_order', arguments: { quoteId: '00000000-0000-4000-8000-000000000000' } });
  log(badOrder.status === 200 && badOrder.json?.result?.isError === true, 'tool error comes back as a tool result, not a crash');
  const unknownTool = await mcp(6, 'tools/call', { name: 'approve_order', arguments: {} });
  log(!!unknownTool.json?.error || unknownTool.json?.result?.isError === true, 'approve_order is refused (no such tool)');
  const evil = await mcp(7, 'tools/list', {}, { Origin: 'https://evil.example' });
  log(evil.status === 403, 'foreign browser origin refused', `HTTP ${evil.status}`);
  const nullOrigin = await mcp(8, 'tools/list', {}, { Origin: 'null' });
  log(nullOrigin.status === 403, 'Origin "null" refused cleanly', `HTTP ${nullOrigin.status}`);

  // --- 4. Audit chain
  console.log('\nRecord');
  const chain = await http('GET', '/api/audit/verify', undefined, {}, 60_000);
  log(chain.json?.valid === true, 'audit chain verifies', chain.json?.valid ? `${chain.json.checked} events` : chain.json?.reason);

  console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.log(`FAIL  script error: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
