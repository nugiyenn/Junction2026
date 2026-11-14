import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { describe, it } from 'node:test';
import { Encodings } from '@pdf-lib/standard-fonts';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  agentSafeReasons,
  buildConfirmationModel,
  CONFIRMATION_FOOTER,
  contextFromReceipt,
  deviceKeyFingerprint,
  sanitizeWinAnsi,
  type ConfirmationModel,
} from '../src/lib/confirmation.ts';
import { qrRuns, renderConfirmationPdf } from '../src/lib/confirmation-pdf.ts';
import { DEVIATION_REASON } from '../src/lib/deviation.ts';
import { exposeOrder } from '../src/lib/exposure.ts';
import { buildReceipt } from '../src/lib/receipt-build.ts';
import type { Mandate, Order, PublicJwk, QuoteLine, Quote, ReceiptAuditEvent, ReceiptBundle } from '../src/types/index.ts';

const ORDER_ID = '22222222-2222-4222-8222-222222222222';
const QUOTE_ID = '11111111-1111-4111-8111-111111111111';

/** A raw line with every field the buyer must never see, so the tests can look for them. */
const rawLine = (i = 0, name = 'Milk'): QuoteLine => ({
  productId: `64104050${String(60000 + i)}`,
  name,
  quantity: 10 + i,
  salesUnit: 'KI',
  unitPrice: 12.5,
  unitPriceWithTax: 13.75,
  comparisonPrice: 2.5,
  comparisonUnit: 'L',
  lineTotal: 125 + i * 12.5,
  lineTotalWithTax: 137.5,
  availableAmount: 51,
  availableDate: '2026-11-16',
  closingTime: null,
  logisticModel: 'Stock',
  fulfillable: true,
  issues: [],
  substitutes: [],
  internal: { listPrice: 20, discountPct: 37.5, netPriceFound: true, availableAmount: 51, vendorName: 'Secret Dairy Oy', category: 'Dairy' },
});

const mandate: Mandate = {
  id: 'demo-hotel',
  buyerName: 'Hotel Aurora',
  agentName: 'Purchasing agent',
  autoApproveLimitEur: 100,
  maxOrderEur: 1000,
  blockedAllergens: [],
  minDeliveryReliability: null,
  requireConfirmedStock: false,
  maxCo2PerKg: null,
  preferredOffer: 'cheapest',
};

const order = (over: Partial<Order> = {}, lines: QuoteLine[] = [rawLine()]): Order => ({
  id: ORDER_ID,
  quoteId: QUOTE_ID,
  mandateId: 'demo-hotel',
  status: 'confirmed',
  policyReasons: [],
  deliveryDate: '2026-11-16',
  currency: 'EUR',
  lines,
  total: lines.reduce((t, l) => t + (l.lineTotal ?? 0), 0),
  totalWithTax: 0,
  createdAt: '2026-11-14T10:01:00.000Z',
  decidedBy: null,
  decidedAt: null,
  decisionNote: null,
  ...over,
});

const quote = (o: Order): Quote => ({
  id: QUOTE_ID,
  mandateId: 'demo-hotel',
  deliveryDate: o.deliveryDate,
  currency: 'EUR',
  lines: o.lines,
  total: o.total,
  totalWithTax: o.totalWithTax,
  fulfillable: true,
  createdAt: '2026-11-14T10:00:00.000Z',
  expiresAt: '2026-11-14T10:15:00.000Z',
  signature: { alg: 'EdDSA', keyId: 'valio-test-key-1', value: 'sig' },
});

const HEAD = 'ab12'.repeat(16);
const event = (id: string, action: ReceiptAuditEvent['action'], hash: string): ReceiptAuditEvent => ({
  id,
  at: '2026-11-14T10:01:00.000Z',
  actor: 'system',
  action,
  mandateId: 'demo-hotel',
  quoteId: QUOTE_ID,
  orderId: ORDER_ID,
  summary: 'x',
  data: {},
  prevHash: null,
  hash,
});

const DEVICE_KEY: PublicJwk = { kty: 'EC', crv: 'P-256', x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU', y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0' };

// buildReceipt reads the outcome from the audit events' data, so the fixture sets it there.
function buildReceiptWith(o: Order, approver: boolean, outcome: ReceiptBundle['policy']['outcome'] = 'auto_approve'): ReceiptBundle {
  const ev = event('1', 'order_confirmed', 'ff'.repeat(32));
  ev.data = { outcome };
  return buildReceipt(
    {
      exportedAt: '2026-11-14T11:00:00.000Z',
      order: o,
      quote: quote(o),
      mandate,
      audit: { events: [ev, event('2', 'order_approved', HEAD)], linked: true, head: { id: '90', hash: 'cd'.repeat(32) } },
      approverSignature: approver
        ? { alg: 'ES256', payload: { orderId: ORDER_ID, decision: 'approve', decidedBy: o.decidedBy ?? '', note: null, signedAt: o.decidedAt ?? '' }, value: 'v', publicKey: DEVICE_KEY }
        : null,
    },
    () => ({ keyId: 'valio-test-key-1', value: 'sig' })
  );
}

const ORIGIN = 'https://example.test';
function modelFor(o: Order, outcome: ReceiptBundle['policy']['outcome'], approver = false): ConfirmationModel {
  const b = JSON.parse(JSON.stringify(buildReceiptWith(o, approver, outcome))) as ReceiptBundle;
  return buildConfirmationModel(b.order, contextFromReceipt(b, ORIGIN));
}

/** Every key anywhere in a value. */
function keysOf(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      keysOf(x, out);
    }
  }
  return out;
}

/** The text a PDF draws: inflate every content stream and decode the hex strings of Tj operators (standard fonts, WinAnsi). */
function pdfText(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString('latin1');
  const parts: string[] = [];
  for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let body: string;
    try {
      body = inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1');
    } catch {
      continue;
    }
    for (const t of body.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) parts.push(Buffer.from(t[1], 'hex').toString('latin1'));
  }
  return parts.join('\n');
}

describe('sanitizeWinAnsi', () => {
  const winAnsiOk = (s: string) => [...s].every((ch) => Encodings.WinAnsi.canEncodeUnicodeCodePoint(ch.codePointAt(0)!));

  it('keeps Finnish and other Latin-1 letters, the euro, registered and trademark signs', () => {
    const s = 'Äiti ö å é ü Ä Ö Å ® ™ € 12,50 Valio Gold&Green® Oddlygood™';
    assert.equal(sanitizeWinAnsi(s), s);
  });

  it('turns spaces and line breaks into one plain space each', () => {
    assert.equal(sanitizeWinAnsi('a b c\td\ne f'), 'a b c d e f');
  });

  it('makes curly quotes, dashes, emoji, Cyrillic, CJK and combining marks drawable', () => {
    const inputs = [
      '“quoted” ‘single’ – — …',
      '‑ − ‛',
      'Молоко',
      '牛乳',
      'Milk \u{1F95B} \u{1F600}',
      'é ñ ő',
      'Łódź ő ž ı',
      '\u0000\u0007​zero﻿width',
    ];
    for (const input of inputs) assert.ok(winAnsiOk(sanitizeWinAnsi(input)), `${JSON.stringify(input)} -> ${JSON.stringify(sanitizeWinAnsi(input))}`);
    assert.equal(sanitizeWinAnsi('Молоко'), '??????');
    assert.equal(sanitizeWinAnsi('Milk \u{1F95B}'), 'Milk ?');
    assert.equal(sanitizeWinAnsi('Łódź'), 'Lódz');
    assert.equal(sanitizeWinAnsi('é'), 'é');
    assert.equal(sanitizeWinAnsi('‑'), '-');
  });

  it('never throws on odd input, and a font can draw what comes out', async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const page = pdf.addPage();
    const nasty = [null, undefined, '', '\u{10FFFF}', '\ud800', 'a'.repeat(500), '  ', 'ǅ ǆ ǈ'];
    for (const n of nasty) {
      const clean = sanitizeWinAnsi(n as string);
      page.drawText(clean, { font, size: 8 });
      assert.ok(winAnsiOk(clean));
    }
  });
});

describe('buildConfirmationModel', () => {
  it('never carries list price, discount, supplier, category or exact stock, even from a raw order', () => {
    const raw = order();
    const exposed = modelFor(raw, 'auto_approve');
    // A caller that forgot to expose the order must still not leak: the model is built from a whitelist.
    const careless = buildConfirmationModel(raw as unknown as ReturnType<typeof exposeOrder>, contextFromReceipt(buildReceiptWith(raw, false), ORIGIN));
    for (const model of [exposed, careless]) {
      const keys = keysOf(model);
      for (const bad of ['vendorName', 'listPrice', 'discountPct', 'availableAmount', 'internal', 'category', 'netPriceFound', 'stock']) {
        assert.ok(!keys.has(bad), `key ${bad} must not be in the model`);
      }
      const json = JSON.stringify(model);
      for (const bad of ['Secret Dairy', 'Dairy', '37.5', '"51"', ':51,']) assert.ok(!json.includes(bad), `${bad} leaked`);
      assert.ok(!/invoice number|VAT \d|payment terms|IBAN/i.test(json.replace(CONFIRMATION_FOOTER, '')));
    }
  });

  it('reads lines, totals, dates and the verify link from the order', () => {
    const m = modelFor(order({}, [rawLine(0), rawLine(1)]), 'auto_approve');
    assert.equal(m.title, 'Order confirmation');
    assert.equal(m.status, 'confirmed');
    assert.equal(m.statusLabel, 'Confirmed');
    assert.equal(m.buyerName, 'Hotel Aurora');
    assert.equal(m.agentName, 'Purchasing agent');
    assert.equal(m.orderId, ORDER_ID);
    assert.equal(m.orderShortId, '22222222');
    assert.equal(m.deliveryDate, '2026-11-16');
    assert.equal(m.lines.length, 2);
    assert.deepEqual({ ...m.lines[0] }, { quantity: 10, unit: 'KI', name: 'Milk', pack: 'Pack about 5 L', substitute: false, unitPrice: 12.5, lineTotal: 125 });
    assert.equal(m.totalExVat, 250 + 12.5);
    assert.equal(m.verification.quoteKeyId, 'valio-test-key-1');
    assert.equal(m.verification.auditHeadHash, HEAD);
    assert.equal(m.verification.verifyUrl, `https://example.test/verify?order=${ORDER_ID}`);
    assert.equal(m.footer, 'Prototype. Synthetic data. This is an order confirmation, not an invoice.');
    assert.equal(m.approval, null);
    assert.match(m.mandate.decision, /^Approved automatically/);
  });

  it('shows only the generic sentence for an unusual-order flag, never baseline numbers', () => {
    const leaky = ["Needs approval: differs from this buyer's usual orders. Usually 1000 L, this is 10000 L (10x)", 'Order total 150.00 EUR is above the auto-approve limit of 100.00 EUR.'];
    assert.deepEqual(agentSafeReasons(leaky), [DEVIATION_REASON, leaky[1]]);
    const m = modelFor(order({ status: 'pending_approval', policyReasons: leaky }), 'needs_approval');
    assert.equal(m.status, 'pending');
    assert.equal(m.statusLabel, 'Waiting for approval');
    assert.deepEqual(m.mandate.reasons, [DEVIATION_REASON, leaky[1]]);
    assert.ok(!JSON.stringify(m).includes('10000'));
    assert.match(m.mandate.decision, /^Needs approval/);
  });

  it('an approved order carries the approver, the time and the first 16 hex of the device key fingerprint; a pending one has none', () => {
    const approved = modelFor(order({ decidedBy: 'Purchasing manager', decidedAt: '2026-11-14T10:05:00.000Z' }), 'needs_approval', true);
    assert.equal(approved.approval?.result, 'approved');
    assert.equal(approved.approval?.decidedBy, 'Purchasing manager');
    assert.equal(approved.approval?.decidedAt, '2026-11-14T10:05:00.000Z');
    assert.match(approved.approval?.deviceKeyFingerprint ?? '', /^[0-9a-f]{16}$/);
    assert.equal(approved.approval?.deviceKeyFingerprint, deviceKeyFingerprint(DEVICE_KEY).slice(0, 16));
    const pending = modelFor(order({ status: 'pending_approval' }), 'needs_approval');
    assert.equal(pending.approval, null);
    // A person decided, but the device did not sign: the approver is named, the fingerprint is absent.
    const unsigned = modelFor(order({ decidedBy: 'Purchasing manager', decidedAt: '2026-11-14T10:05:00.000Z' }), 'needs_approval', false);
    assert.equal(unsigned.approval?.deviceKeyFingerprint, null);
  });

  it('a rejected or declined order is the same document with the status Declined', () => {
    const byMandate = modelFor(order({ status: 'rejected', policyReasons: ['Order total 5000.00 EUR is above the mandate\'s maximum of 1000.00 EUR.'] }), 'reject');
    assert.equal(byMandate.status, 'declined');
    assert.equal(byMandate.statusLabel, 'Declined');
    assert.equal(byMandate.approval, null);
    assert.match(byMandate.mandate.decision, /^Rejected by the mandate/);
  });

  it('the fingerprint does not depend on key order or an added kid', () => {
    assert.equal(deviceKeyFingerprint({ ...DEVICE_KEY, kid: 'x' }), deviceKeyFingerprint({ y: DEVICE_KEY.y, x: DEVICE_KEY.x, crv: 'P-256', kty: 'EC' }));
  });
});

const lineModel = (n: number, name = (i: number) => `Product ${i} lactose free`): ConfirmationModel =>
  modelFor(order({}, Array.from({ length: n }, (_, i) => rawLine(i, name(i)))), 'auto_approve', false);

const pageCount = async (bytes: Uint8Array) => (await PDFDocument.load(bytes)).getPageCount();

describe('renderConfirmationPdf', () => {
  it('returns a PDF for 0, 1 and 100 lines, with the right page counts', async () => {
    const zero = await renderConfirmationPdf(lineModel(0));
    const one = await renderConfirmationPdf(lineModel(1));
    const hundred = await renderConfirmationPdf(lineModel(100));
    for (const bytes of [zero, one, hundred]) assert.equal(Buffer.from(bytes.slice(0, 5)).toString('latin1'), '%PDF-');
    assert.equal(await pageCount(zero), 1);
    assert.equal(await pageCount(one), 1);
    const many = await pageCount(hundred);
    assert.ok(many >= 3 && many <= 8, `100 lines gave ${many} pages`);
    assert.ok(hundred.byteLength < 200_000, `100 lines is ${hundred.byteLength} bytes`);
  });

  it('numbers every page and puts the footer on each', async () => {
    const bytes = await renderConfirmationPdf(lineModel(100));
    const n = await pageCount(bytes);
    const text = pdfText(bytes);
    for (let i = 1; i <= n; i++) assert.ok(text.includes(`Page ${i} of ${n}`), `Page ${i} of ${n}`);
    assert.equal(text.split(CONFIRMATION_FOOTER).length - 1, n);
    // The table header is repeated on every page that holds lines.
    assert.ok(text.split('PRODUCT').length - 1 >= n - 1);
  });

  it('survives long, odd and hostile product names', async () => {
    const names = [
      'Extra long product name '.repeat(30),
      'Supercalifragilisticexpialidocious'.repeat(12),
      'Молоко \u{1F95B} “quoted” name – 牛乳',
      'Maitojuoma ÄÖÅ äöå é ü ® ™ € 1 l',
      '',
    ];
    const bytes = await renderConfirmationPdf(lineModel(names.length, (i) => names[i]));
    assert.equal(await pageCount(bytes), 1);
    const text = pdfText(bytes);
    assert.ok(text.includes('ÄÖÅ äöå é ü ®'), 'Finnish and accented characters are drawn');
  });

  it('wraps a very long hostile buyer, agent and approver name too', async () => {
    const m = modelFor(order({ decidedBy: 'Ö'.repeat(300), decidedAt: '2026-11-14T10:05:00.000Z' }), 'needs_approval', true);
    m.buyerName = 'Buyer \u{1F95B} '.repeat(40);
    m.agentName = 'Агент';
    const bytes = await renderConfirmationPdf(m);
    assert.equal(Buffer.from(bytes.slice(0, 4)).toString('latin1'), '%PDF');
  });

  it('draws the verification block and nothing a buyer must not see', async () => {
    const m = modelFor(order({ status: 'pending_approval', policyReasons: [DEVIATION_REASON] }), 'needs_approval');
    const text = pdfText(await renderConfirmationPdf(m));
    for (const want of ['Order confirmation', 'WAITING FOR APPROVAL', 'Scan to verify this order', m.verification.verifyUrl, 'valio-test-key-1', HEAD, DEVIATION_REASON]) {
      assert.ok(text.includes(want), `missing: ${want}`);
    }
    for (const bad of ['vendorName', 'listPrice', 'discountPct', 'availableAmount', 'Secret Dairy', 'Dairy', 'Invoice', 'invoice number', 'IBAN', 'VAT']) {
      const found = text.replace(CONFIRMATION_FOOTER, '').replace('Total excluding VAT', '').replace("excluding VAT.", '').includes(bad);
      assert.ok(!found, `${bad} must not be in the PDF`);
    }
  });

  it('puts the approver fingerprint in the verification block only when a person signed', async () => {
    const approved = modelFor(order({ decidedBy: 'Purchasing manager', decidedAt: '2026-11-14T10:05:00.000Z' }), 'needs_approval', true);
    const text = pdfText(await renderConfirmationPdf(approved));
    assert.ok(text.includes(approved.approval!.deviceKeyFingerprint!));
    assert.ok(text.includes('Approved by Purchasing manager'));
    const pending = pdfText(await renderConfirmationPdf(modelFor(order({ status: 'pending_approval' }), 'needs_approval')));
    assert.ok(!pending.includes('Approver device key'));
  });
});

describe('QR code', () => {
  it('encodes exactly the verify URL, with the same matrix every time', () => {
    const m = modelFor(order(), 'auto_approve');
    assert.equal(m.verification.verifyUrl, `${ORIGIN}/verify?order=${ORDER_ID}`);
    const a = qrRuns(m.verification.verifyUrl);
    const b = qrRuns(m.verification.verifyUrl);
    assert.deepEqual(a, b);
    assert.notDeepEqual(a, qrRuns(`${ORIGIN}/verify?order=${QUOTE_ID}`));
    assert.ok(a.size >= 21 && a.size % 4 === 1, `a QR size is 17 + 4 x version, got ${a.size}`);
    // Finder patterns in three corners: the top-left 7x7 ring is dark on its first row.
    assert.ok(a.runs.some((r) => r.row === 0 && r.col === 0 && r.len >= 7));
  });
});
