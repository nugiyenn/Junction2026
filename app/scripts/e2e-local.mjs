// End-to-end check against a running dev server (default http://localhost:3000):
//   node scripts/e2e-local.mjs            (BASE=http://localhost:3010 to point elsewhere)
// It exercises the real services: auto-approval, escalation to a human, the MCP tools, idempotency, the data firewall,
// the audit chain and the live web checks. It writes real quotes, orders and audit events to the database
// (use "Reset demo data" afterwards) and spends model and web quota: about two full requests. Prints PASS/FAIL, never keys.

import { inflateSync } from 'node:zlib';

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


/** The text a PDF draws: content streams are Flate-compressed, so inflate each and read the hex strings of its Tj operators. */
const pdfText = (bytes) => {
  const raw = Buffer.from(bytes).toString('latin1');
  const parts = [];
  for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let body;
    try { body = inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'); } catch { continue; }
    for (const t of body.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) parts.push(Buffer.from(t[1], 'hex').toString('latin1'));
  }
  return parts.join('\n');
};

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
      // Order confirmation (PDF) for the same order: a document, not an invoice, with nothing the buyer must not see.
      const pdfRes = await fetch(`${BASE}/api/orders/${order.id}/confirmation`, { signal: AbortSignal.timeout(60_000) });
      const pdf = new Uint8Array(await pdfRes.arrayBuffer());
      log(pdfRes.status === 200 && (pdfRes.headers.get('content-type') ?? '').startsWith('application/pdf'), 'order confirmation is a PDF', `HTTP ${pdfRes.status}, ${pdfRes.headers.get('content-type')}`);
      log(Buffer.from(pdf.slice(0, 4)).toString('latin1') === '%PDF' && pdf.byteLength < 200_000, 'confirmation starts with %PDF and is under 200 KB', `${pdf.byteLength} bytes`);
      log(/inline; filename="order-confirmation-[0-9a-f]{8}\.pdf"/.test(pdfRes.headers.get('content-disposition') ?? ''), 'confirmation opens inline with a clear file name');
      // The content streams are compressed, so the raw bytes cannot be searched: look at the text the PDF draws.
      const drawn = pdfText(pdf);
      log(drawn.includes('Order confirmation') && drawn.includes(`verify?order=${order.id}`), 'confirmation text is readable and links to /verify for this order', `${drawn.length} characters drawn`);
      log(!/vendorName|listPrice|discountPct|availableAmount/i.test(drawn) && !/invoice number|IBAN/i.test(drawn), 'confirmation hides list price, discount, supplier and exact stock, and names no invoice detail');
      log(drawn.includes('Prototype. Synthetic data. This is an order confirmation, not an invoice.'), 'confirmation carries the prototype footer');
      const noPdf = await http('GET', '/api/orders/00000000-0000-4000-8000-000000000000/confirmation', undefined, {}, 30_000);
      log(noPdf.status === 404, 'confirmation for an unknown order is a plain 404', `HTTP ${noPdf.status}`);
    }
  }

  // --- Recipe order: pasted list -> matched lines (no model unless the text is prose)
  console.log('\nRecipe order');
  const STATUSES = ['matched', 'weak', 'not_found', 'unpriced'];
  const leaky = (text) => /"vendorName"|"listPrice"|"discountPct"|"availableAmount"|"internal"|"category"/.test(text);
  const pizzeria = await http('POST', '/api/recipe', { mandateId: 'demo-hotel', text: '20 kg mozzarella\n10 kg tomato sauce\npizza dough 50 pcs' }, {}, 2 * MINUTE);
  const matchedLines = (pizzeria.json?.lines ?? []).filter((l) => l.status === 'matched');
  log(pizzeria.status === 200 && matchedLines.length >= 2, 'recipe: 3-line pizzeria list, at least 2 lines matched', `HTTP ${pizzeria.status}, ${matchedLines.length} matched`);
  log(!leaky(pizzeria.text), 'recipe: response hides supplier, list price, discount and exact stock');
  log((pizzeria.json?.lines ?? []).every((l) => l.readBy === 'code'), 'recipe: a plain list is read by code, not a model');
  const t0 = Date.now();
  const recipe15 = [
    '0,323 kg', '[Oddlygood® Cooking Oat tuotetta](https://www.valioaimo.fi/ammattilaistuotteet/oddlygood-cooking-oat-original/1-l-tolkki/)',
    '0,277 kg Oddlygood® Dream Fraiche tuotetta', '1,062 kg kylmää vettä', '0,037 kg punaviinietikkaa', '0,016 kg valkosipulimurskaa',
    '0,139 kg tomaattipyreetä', '0,021 kg kasvisliemijauhetta', '0,002 kg suolaa', '0,001 kg jauhettua mustapippuria', '0,003 kg kuivattua rakuunaa',
    '0,009 kg sokeria', '0,021 kg kylmätärkkelystä', '0,877 kg', '[Valio Gold&Green® suikaleita original](https://www.valioaimo.fi/ammattilaistuotteet/valio-goldgreen-suikale-original/)',
    '0,277 kg fenkolia', '0,111 kg pakastesipulikuutioita',
  ].join('\n');
  const full = await http('POST', '/api/recipe', { mandateId: 'demo-hotel', text: recipe15 }, {}, 2 * MINUTE);
  const took = (Date.now() - t0) / 1000;
  const fullLines = full.json?.lines ?? [];
  log(full.status === 200 && fullLines.length === 15 && took < 60, 'recipe: 15-line recipe answered within 60 s', `HTTP ${full.status}, ${fullLines.length} lines, ${took.toFixed(1)} s`);
  log(fullLines.every((l) => STATUSES.includes(l.status)), 'recipe: every line has one of the four statuses', STATUSES.map((st) => `${st} ${fullLines.filter((l) => l.status === st).length}`).join(', '));
  log(!leaky(full.text), 'recipe: the 15-line response hides supplier, list price, discount and exact stock');
  const long = await http('POST', '/api/recipe', { mandateId: 'demo-hotel', text: '2 kg flour\n'.repeat(500) }, {}, 30_000);
  log(long.status === 400 && /4000/.test(long.json?.error ?? '') && !/[{}\[\]]|zod/i.test(long.json?.error ?? ''), 'recipe: 5000 characters get a plain 400', long.json?.error?.slice(0, 80));
  const garbage = await http('POST', '/api/recipe', { mandateId: 'demo-hotel', text: 'asdf qwer ;;; ???' }, {}, 30_000);
  log(garbage.status === 422 && !/[{}\[\]]|zod/i.test(garbage.json?.error ?? ''), 'recipe: garbage text gets a plain 422', garbage.json?.error?.slice(0, 80));
  const prose = await http('POST', '/api/recipe', { mandateId: 'demo-hotel', text: 'I need 20 kg of mozzarella and 10 kg of tomato sauce for friday' }, {}, 2 * MINUTE);
  const proseOk = prose.status === 200 && prose.json?.lines?.length === 2 && prose.json.lines.every((l) => l.readBy === 'model') && prose.json.readByModel === true;
  const proseDown = prose.status === 422 && /^Could not read this as a list/.test(prose.json?.error ?? '');
  log(proseOk || proseDown, 'recipe: a sentence is read by a model (2 lines), or the model is down and the message is plain', proseOk ? `2 lines, delivery ${prose.json.deliveryDate}` : `HTTP ${prose.status} ${prose.json?.error}`);
  log(prose.status < 500 && prose.json !== null, 'recipe: a sentence never gives a server error or raw text');
  // One quote from the matched lines, then the normal order flow: a big total waits for a person.
  const quotable = fullLines.filter((l) => l.status === 'matched' && l.proposal?.fulfillable && l.proposal.quantity);
  if (quotable.length >= 2) {
    const q = await http('POST', '/api/quotes', { mandateId: 'demo-hotel', deliveryDate: full.json.deliveryDate, lines: quotable.map((l) => ({ productId: l.proposal.productId, quantity: l.proposal.quantity })) }, {}, 60_000);
    log(q.status === 201 && q.json?.quote?.lines?.length === quotable.length, 'recipe: the matched lines become one quote', `HTTP ${q.status}, ${q.json?.quote?.lines?.length} lines, €${q.json?.quote?.total}`);
    log(!!q.json?.policy?.outcome, 'recipe: the quote carries the mandate decision', q.json?.policy?.outcome);
  }

  // --- New surfaces
  console.log('\nNew features');
  const stats = await http('GET', '/api/stats?mandateId=demo-hotel', undefined, {}, 60_000);
  log(stats.status === 200 && !!stats.json?.source, 'buyer stats answer', `source: ${stats.json?.source}`);
  const catalog = await http('GET', '/api/products/search?q=oat%20drink&limit=3', undefined, {}, 60_000);
  log(catalog.status === 200 && !/"vendorName"|"category"/.test(catalog.text), 'catalog search hides supplier and internal category');
  for (const page of ['/', '/recipe', '/approvals', '/exposure', '/audit', '/stats', '/models', '/verify']) {
    const res = await fetch(BASE + page, { signal: AbortSignal.timeout(60_000) });
    log(res.status === 200, `page ${page} loads`, `HTTP ${res.status}`);
  }
  log(typeof health.json?.approverKeyRequired === 'boolean', 'health reports whether the approver key is required', String(health.json?.approverKeyRequired));

  // --- Unusual order check: the same weekly milk order, then a swap, 10x and a holiday week (no model involved)
  console.log('\nUnusual order check (hotel, weekly milk)');
  const GENERIC = "Needs approval: differs from this buyer's usual orders.";
  const mondayAfter = (() => { const d = new Date(); d.setDate(d.getDate() + (((8 - d.getDay()) % 7) || 7)); return d.toISOString().slice(0, 10); })();
  // As an agent would: a quote by product id, then the order with an Idempotency-Key.
  const placeHotel = async (productId, quantity) => {
    const q = await http('POST', '/api/quotes', { mandateId: 'demo-hotel', deliveryDate: mondayAfter, lines: [{ productId, quantity }] }, {}, 60_000);
    if (q.status !== 201) return { q, order: null };
    const o = await http('POST', '/api/orders', { quoteId: q.json.quote.id }, { 'Idempotency-Key': `e2e-unusual-${productId}-${quantity}-${Date.now()}` }, 60_000);
    return { q, o, order: o.json?.order };
  };
  const SKIMMED = '469477', WHOLE = '464073';
  // Other milks to swap to. A product that an earlier run accepted as the new normal is no longer flagged, so take the first one that still is (Reset demo data starts over).
  const SWAPS = ['469549', '464201', '464398', '464306', '464401'];
  const agentLeak = (r) => /Fat per 100 g|instead of the usual|basedOn|"usual"|usual[^"]{0,40}\d/i.test(JSON.stringify([r.q?.json, r.o?.json]));
  const report = async (orderId) => (await http('GET', `/api/orders/${orderId}/deviation`, undefined, {}, 30_000));

  const hist = await http('GET', '/api/stats?mandateId=demo-hotel', undefined, {}, 60_000);
  const usualA = await placeHotel(SKIMMED, 1000);
  log(usualA.order?.id !== undefined, 'scenario (a) usual weekly milk: order placed', usualA.order?.status ?? usualA.q.json?.error);
  if (usualA.order) {
    const repA = (await report(usualA.order.id)).json?.report;
    log(repA?.hasBaseline === true && repA.basedOn >= 4, 'seed present: demo-hotel has a standing baseline', `based on ${repA?.basedOn} orders`);
    log(repA?.differing === 0 && !usualA.order.policyReasons.includes(GENERIC), '(a) 1,000 L skimmed is not flagged', `${repA?.differing} of ${repA?.total} differ; ${usualA.order.status}`);
    const held = usualA.order.status === 'pending_approval' ? usualA.order.policyReasons.join(' | ').slice(0, 90) : 'auto-approved';
    log(['confirmed', 'pending_approval'].includes(usualA.order.status), '(a) held or confirmed only by the total limit or the rolling 24 h rule, not by this check', held);
  }
  log(hist.status === 200, 'stats still answer with the standing orders in place', `source: ${hist.json?.source}`);

  const swapped = await placeHotel(WHOLE, 1000);
  const orderB = swapped.order;
  log(orderB?.status === 'pending_approval' && orderB.policyReasons.includes(GENERIC), '(b) whole milk instead of skimmed waits for approval, flagged', orderB?.status ?? swapped.q.json?.error);
  log(swapped.q.json?.policy?.reasons?.includes(GENERIC) === true, '(b) the quote preview says the same generic sentence');
  log(!agentLeak(swapped), '(b) agent view is generic: no baseline, no attributes, no numbers');
  if (orderB) {
    const rep = await report(orderB.id);
    const fat = rep.json?.report?.checks?.find((c) => c.label === 'Fat per 100 g');
    log(rep.status === 200 && rep.json?.report?.differing === 1, '(b) approver endpoint: one finding differs', `${rep.json?.report?.differing} of ${rep.json?.report?.total}`);
    log(fat?.result === 'review' && /^\+3\.5 g$/.test(fat.detail ?? '') && fat.usual === '0 g', '(b) approver view shows the fat difference', fat ? `${fat.usual} vs ${fat.thisOrder}, ${fat.detail}` : 'no fat row');
    log((rep.json?.report?.checks ?? []).some((c) => c.label === 'Delivery weekday' && /^Monday, \d+ of \d+$/.test(c.usual)), '(b) the usual column carries its evidence', (rep.json?.report?.checks ?? []).find((c) => c.label === 'Quantity')?.usual);
    const audit = await http('GET', '/api/audit?mandateId=demo-hotel', undefined, {}, 30_000);
    log(audit.status === 200 && !/deviation_report|Fat per 100 g|instead of the usual/.test(audit.text), 'the open audit feed never carries the report');
    if (health.json?.approverKeyRequired === true) {
      const open = await http('GET', `/api/orders/${orderB.id}/deviation`, undefined, { Authorization: 'Bearer wrong' }, 30_000);
      log(open.status === 401, 'the report endpoint needs the approver key', `HTTP ${open.status}`);
    } else {
      log(true, 'the report endpoint is open because no approver key is configured here (same as the other approver routes)');
    }
    const bad = await http('POST', `/api/orders/${orderB.id}/decision`, { decision: 'decline', decidedBy: 'e2e script', acceptAsNormal: true }, {}, 30_000);
    log(bad.status === 400, 'accepting a decline as the new normal is refused', `HTTP ${bad.status}`);
    const declined = await http('POST', `/api/orders/${orderB.id}/decision`, { decision: 'decline', decidedBy: 'e2e script', note: 'automated check' }, {}, 30_000);
    log(declined.status === 200, '(b) the flagged order is declined to leave the inbox', `HTTP ${declined.status}`);
  }

  const ten = await placeHotel(SKIMMED, 10000);
  log(ten.q.json?.policy?.reasons?.includes(GENERIC) && ten.q.json.policy.reasons.some((x) => /maximum/.test(x)), '(c) 10x quantity is flagged and also meets the existing maximum rule', ten.q.json?.policy?.outcome);
  if (ten.order) {
    const rep = (await report(ten.order.id)).json?.report;
    log(rep?.checks?.some((c) => c.label === 'Quantity' && c.result === 'review'), '(c) approver view: the quantity differs', rep?.checks?.find((c) => c.label === 'Quantity')?.detail);
    log(ten.order.status === 'rejected' && !agentLeak(ten), '(c) the existing maximum rejects it; the check never rejects by itself', ten.order.status);
  }

  const holiday = await placeHotel(SKIMMED, 1200);
  if (holiday.order) {
    const rep = (await report(holiday.order.id)).json?.report;
    log(rep?.differing === 0 && !holiday.order.policyReasons.includes(GENERIC), '(d) a +20% holiday week is not flagged', `${rep?.differing} of ${rep?.total} differ; ${holiday.order.status}`);
  } else log(false, '(d) holiday order placed', holiday.q.json?.error);

  // Accepting a flagged order as the new normal changes the next evaluation. Another milk than the demo's whole milk is used, so that scenario stays flagged.
  let semi = { order: null, q: { json: { error: 'every swap candidate was already accepted by earlier runs: Reset demo data and run again' } } };
  let SEMI = SWAPS[0];
  for (const candidate of SWAPS) {
    SEMI = candidate;
    semi = await placeHotel(candidate, 1000);
    if (semi.order?.policyReasons?.includes(GENERIC)) break;
    if (semi.order?.status === 'pending_approval') await http('POST', `/api/orders/${semi.order.id}/decision`, { decision: 'decline', decidedBy: 'e2e script', note: 'automated check, not flagged' }, {}, 30_000);
  }
  if (semi.order?.status === 'pending_approval' && semi.order.policyReasons.includes(GENERIC)) {
    const accepted = await http('POST', `/api/orders/${semi.order.id}/decision`, { decision: 'approve', decidedBy: 'e2e script', note: 'automated check', acceptAsNormal: true }, {}, 60_000);
    log(accepted.status === 200 && accepted.json?.order?.status === 'confirmed', 'approve and accept as new normal', accepted.json?.order?.status ?? accepted.json?.error);
    const again = await http('POST', '/api/quotes', { mandateId: 'demo-hotel', deliveryDate: mondayAfter, lines: [{ productId: SEMI, quantity: 1000 }] }, {}, 60_000);
    log(again.json?.policy && !again.json.policy.reasons.includes(GENERIC), 'after accepting, the same order is no longer flagged', again.json?.policy?.reasons?.join(' | ').slice(0, 80));
    const trail = await http('GET', `/api/audit?orderId=${semi.order.id}`, undefined, {}, 30_000);
    log((trail.json?.events ?? []).some((e) => e.action === 'order_accepted_as_normal'), 'the acceptance is in the audit trail');
  } else log(false, 'a swapped milk is flagged (to test accept as new normal)', semi.order?.status ?? semi.q.json?.error);
  // Leave the inbox as it was found: the usual and holiday orders are only held by the total limit, so decline them.
  for (const o of [usualA.order, holiday.order]) {
    if (o?.status === 'pending_approval') await http('POST', `/api/orders/${o.id}/decision`, { decision: 'decline', decidedBy: 'e2e script', note: 'automated check, cleaning up' }, {}, 30_000);
  }

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
