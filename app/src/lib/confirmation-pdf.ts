import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import qrcode from 'qrcode-generator';
import { sanitizeWinAnsi, type ConfirmationModel, type ConfirmationStatus } from './confirmation.ts';
import { LOGO_PNG_BASE64, LOGO_SIZE } from './confirmation-logo.ts';

// Renders the order confirmation as an A4 PDF. Pure JavaScript (pdf-lib and a QR generator), no files read at runtime:
// the logo is a base64 constant and the fonts are PDF's standard ones, so it runs in a Vercel function as it is.
// Only the model is drawn (see confirmation.ts for what it may hold), and every string goes through sanitizeWinAnsi first.

const A4 = { w: 595.28, h: 841.89 };
const MARGIN = 42;
const CONTENT_W = A4.w - MARGIN * 2;
const FOOTER_H = 44;
/** The lowest y (from the top) that content may reach before the footer. */
const BODY_BOTTOM = A4.h - FOOTER_H - 12;
const MM = 72 / 25.4;

const PETROL = rgb(0, 0x56 / 255, 0x70 / 255);
const LIME = rgb(0xc0 / 255, 0xe0 / 255, 0x21 / 255);
const INK = rgb(0x23 / 255, 0x28 / 255, 0x2d / 255);
const GREY = rgb(0x55 / 255, 0x57 / 255, 0x59 / 255);
const SOFT = rgb(0xf2 / 255, 0xf7 / 255, 0xf8 / 255);
const HAIR = rgb(0xd9 / 255, 0xe6 / 255, 0xea / 255);
const WHITE = rgb(1, 1, 1);

/** Badge colours per status: text on lime is petrol, never white. */
const BADGE: Record<ConfirmationStatus, { fill: ReturnType<typeof rgb>; text: ReturnType<typeof rgb> }> = {
  confirmed: { fill: LIME, text: PETROL },
  pending: { fill: rgb(0xfd / 255, 0xdb / 255, 0x32 / 255), text: INK },
  declined: { fill: rgb(0xff / 255, 0xc9 / 255, 0xc6 / 255), text: rgb(0x9a / 255, 0x1b / 255, 0x16 / 255) },
};

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  mono: PDFFont;
}

const money = (n: number | null) =>
  n === null || n === undefined || !Number.isFinite(n) ? '-' : n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

const qty = (n: number) => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3))));

/** "2026-11-14 15:02 UTC" from an ISO timestamp; the text unchanged when it is not one. */
function stamp(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
}

/** Breaks `text` into lines no wider than `width`; a word wider than the line is cut. */
export function wrapText(text: string, font: PDFFont, size: number, width: number): string[] {
  text = sanitizeWinAnsi(text);
  const lines: string[] = [];
  let line = '';
  const widthOf = (s: string) => font.widthOfTextAtSize(s, size);
  for (const word of text.split(' ')) {
    if (!word) continue;
    const trial = line ? `${line} ${word}` : word;
    if (widthOf(trial) <= width) {
      line = trial;
      continue;
    }
    if (line) lines.push(line);
    line = '';
    let rest = word;
    while (widthOf(rest) > width) {
      let cut = rest.length - 1;
      while (cut > 1 && widthOf(rest.slice(0, cut)) > width) cut--;
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    line = rest;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

/** At most `maxLines` lines; when there is more, the last one ends in an ellipsis and still fits. */
function wrapLimited(text: string, font: PDFFont, size: number, width: number, maxLines: number): string[] {
  const lines = wrapText(text, font, size, width);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1];
  while (last.length > 0 && font.widthOfTextAtSize(`${last}…`, size) > width) last = last.slice(0, -1);
  kept[maxLines - 1] = `${last.trimEnd()}…`;
  return kept;
}

/** The QR code as horizontal runs of dark modules, so no hairline gaps show between neighbouring squares. */
export function qrRuns(text: string): { size: number; runs: { row: number; col: number; len: number }[] } {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const size = qr.getModuleCount();
  const runs: { row: number; col: number; len: number }[] = [];
  for (let row = 0; row < size; row++) {
    let col = 0;
    while (col < size) {
      if (!qr.isDark(row, col)) {
        col++;
        continue;
      }
      const start = col;
      while (col < size && qr.isDark(row, col)) col++;
      runs.push({ row, col: start, len: col - start });
    }
  }
  return { size, runs };
}

const logoBytes = () => Uint8Array.from(atob(LOGO_PNG_BASE64), (c) => c.charCodeAt(0));

/** A4 portrait order confirmation. Throws only if pdf-lib itself fails: no string in the model can. */
export async function renderConfirmationPdf(model: ConfirmationModel): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const fonts: Fonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
    mono: await pdf.embedFont(StandardFonts.Courier),
  };
  const logo: PDFImage = await pdf.embedPng(logoBytes());
  const clean = sanitizeWinAnsi;

  pdf.setTitle(clean(`Order confirmation ${model.orderShortId}`));
  pdf.setSubject('Order confirmation (not an invoice)');
  pdf.setProducer('Valio Aimo agent order desk prototype');
  pdf.setCreator('Valio Aimo agent order desk prototype');
  const created = new Date(model.createdAt);
  if (!Number.isNaN(created.getTime())) {
    pdf.setCreationDate(created);
    pdf.setModificationDate(created);
  }

  let page!: PDFPage;
  /** Cursor, measured down from the top edge of the page. */
  let y = 0;

  // Drawing helpers: coordinates are given from the top of the page, as pdf-lib wants them from the bottom.
  const text = (s: string, x: number, top: number, size: number, font: PDFFont, color = INK) =>
    page.drawText(clean(s), { x, y: A4.h - top - size * 0.8, size, font, color });
  const textRight = (s: string, xRight: number, top: number, size: number, font: PDFFont, color = INK) => {
    const c = clean(s);
    page.drawText(c, { x: xRight - font.widthOfTextAtSize(c, size), y: A4.h - top - size * 0.8, size, font, color });
  };
  const rect = (x: number, top: number, w: number, h: number, color: ReturnType<typeof rgb>) =>
    page.drawRectangle({ x, y: A4.h - top - h, width: w, height: h, color });
  const frame = (x: number, top: number, w: number, h: number, color: ReturnType<typeof rgb>) =>
    page.drawRectangle({ x, y: A4.h - top - h, width: w, height: h, borderColor: color, borderWidth: 0.75 });

  const newPage = () => {
    page = pdf.addPage([A4.w, A4.h]);
    rect(0, 0, A4.w, A4.h, WHITE);
    rect(0, 0, A4.w, 7, LIME);
    y = 30;
    return page;
  };

  const need = (height: number) => {
    if (y + height > BODY_BOTTOM) newPage();
  };

  // --- First page: logo, title, status badge, key facts
  newPage();
  const logoW = 108;
  const logoH = (logoW * LOGO_SIZE.height) / LOGO_SIZE.width;
  page.drawImage(logo, { x: MARGIN, y: A4.h - y - logoH, width: logoW, height: logoH });
  y += logoH + 16;

  text(model.title, MARGIN, y, 26, fonts.bold, PETROL);
  const badge = BADGE[model.status];
  const badgeText = clean(model.statusLabel).toUpperCase();
  const badgeW = fonts.bold.widthOfTextAtSize(badgeText, 10) + 24;
  rect(MARGIN + CONTENT_W - badgeW, y + 3, badgeW, 22, badge.fill);
  text(badgeText, MARGIN + CONTENT_W - badgeW + 12, y + 9.5, 10, fonts.bold, badge.text);
  y += 36;

  // Key facts: two columns on a soft panel.
  const facts: [string, string][] = [
    ['Buyer', model.buyerName],
    ['Agent', model.agentName],
    ['Order id', model.orderShortId],
    ['Delivery date', model.deliveryDate],
    ['Created', stamp(model.createdAt)],
    ['Lines', String(model.lines.length)],
  ];
  const colW = CONTENT_W / 2 - 24;
  const rowsH = 33;
  const panelH = Math.ceil(facts.length / 2) * rowsH + 16;
  rect(MARGIN, y, CONTENT_W, panelH, SOFT);
  facts.forEach(([label, value], i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = MARGIN + 16 + col * (CONTENT_W / 2);
    const top = y + 12 + row * rowsH;
    text(label.toUpperCase(), x, top, 7.5, fonts.bold, GREY);
    const shown = wrapLimited(value, fonts.bold, 11, colW, 1)[0];
    text(shown, x, top + 12, 11, fonts.bold, INK);
  });
  y += panelH + 6;
  // The full id, small, under the panel: the short one above is its first 8 characters.
  text(`Full order id: ${model.orderId}`, MARGIN, y, 7.5, fonts.mono, GREY);
  y += 18;

  // --- Lines table
  const colQty = { x: MARGIN + 8, w: 66 };
  const colTotal = { right: MARGIN + CONTENT_W - 8, w: 72 };
  const colPrice = { right: colTotal.right - colTotal.w - 10, w: 64 };
  const colName = { x: colQty.x + colQty.w + 8, w: colPrice.right - colPrice.w - 10 - (colQty.x + colQty.w + 8) };
  const HEADER_H = 22;

  const tableHeader = () => {
    rect(MARGIN, y, CONTENT_W, HEADER_H, PETROL);
    text('QTY', colQty.x, y + 7, 8, fonts.bold, WHITE);
    text('PRODUCT', colName.x, y + 7, 8, fonts.bold, WHITE);
    textRight(`UNIT PRICE ${model.currency}`, colPrice.right, y + 7, 8, fonts.bold, WHITE);
    textRight(`LINE TOTAL ${model.currency}`, colTotal.right, y + 7, 8, fonts.bold, WHITE);
    y += HEADER_H;
  };

  need(HEADER_H + 40);
  tableHeader();
  if (model.lines.length === 0) {
    rect(MARGIN, y, CONTENT_W, 30, SOFT);
    text('This order has no lines.', colName.x, y + 10, 9, fonts.regular, GREY);
    y += 30;
  }
  model.lines.forEach((line, i) => {
    const nameLines = wrapLimited(line.name, fonts.regular, 9, colName.w, 3);
    const notes = [line.pack, line.substitute ? 'Substitute product' : null].filter((n): n is string => !!n);
    const rowH = 8 + nameLines.length * 11.5 + notes.length * 10 + 5;
    if (y + rowH > BODY_BOTTOM) {
      newPage();
      tableHeader();
    }
    if (i % 2 === 1) rect(MARGIN, y, CONTENT_W, rowH, SOFT);
    text(`${qty(line.quantity)} x ${line.unit}`, colQty.x, y + 6, 9, fonts.regular);
    nameLines.forEach((l, k) => text(l, colName.x, y + 6 + k * 11.5, 9, fonts.regular));
    notes.forEach((n, k) => text(n, colName.x, y + 6 + nameLines.length * 11.5 + k * 10, 7.5, fonts.regular, GREY));
    textRight(money(line.unitPrice), colPrice.right, y + 6, 9, fonts.regular);
    textRight(money(line.lineTotal), colTotal.right, y + 6, 9, fonts.regular);
    y += rowH;
  });
  page.drawLine({ start: { x: MARGIN, y: A4.h - y }, end: { x: MARGIN + CONTENT_W, y: A4.h - y }, thickness: 0.75, color: PETROL });

  // --- Totals (ex VAT only: this is not an invoice)
  need(60);
  y += 12;
  const totalsX = MARGIN + CONTENT_W - 230;
  text('Total excluding VAT', totalsX, y + 2, 10, fonts.regular, GREY);
  textRight(`${money(model.totalExVat)} ${model.currency}`, MARGIN + CONTENT_W, y, 15, fonts.bold, PETROL);
  y += 22;
  text('Prices are the buyer\'s own prices for this order, excluding VAT.', MARGIN, y, 7.5, fonts.regular, GREY);
  y += 20;

  // --- Mandate decision and approval
  const reasonLines = model.mandate.reasons.flatMap((r) => wrapText(`- ${clean(r)}`, fonts.regular, 9, CONTENT_W - 8));
  const decisionLines = wrapText(clean(model.mandate.decision), fonts.bold, 10, CONTENT_W - 8);
  const approvalLines = model.approval
    ? wrapText(`${model.approval.result === 'approved' ? 'Approved' : 'Declined'} by ${model.approval.decidedBy} at ${stamp(model.approval.decidedAt)}`, fonts.regular, 9, CONTENT_W)
    : [];
  const approvalH = approvalLines.length ? 4 + approvalLines.length * 12 : 0;
  need(24 + decisionLines.length * 13 + reasonLines.length * 12 + approvalH + 16);
  text('MANDATE DECISION', MARGIN, y, 8, fonts.bold, PETROL);
  y += 15;
  decisionLines.forEach((l) => {
    text(l, MARGIN, y, 10, fonts.bold);
    y += 13;
  });
  reasonLines.forEach((l) => {
    text(l, MARGIN + 6, y, 9, fonts.regular, INK);
    y += 12;
  });
  if (model.approval) {
    y += 4;
    for (const l of approvalLines) {
      text(l, MARGIN, y, 9, fonts.regular);
      y += 12;
    }
  }
  y += 16;

  // --- Verification block: facts on the left, QR code on the right
  const qrMm = 28;
  const qrSize = qrMm * MM;
  const pad = 14;
  const blockH = qrSize + pad * 2 + 26;
  need(blockH + 10);
  rect(MARGIN, y, CONTENT_W, blockH, SOFT);
  frame(MARGIN, y, CONTENT_W, blockH, HAIR);
  text('VERIFICATION', MARGIN + pad, y + pad - 2, 8, fonts.bold, PETROL);

  // QR code on a white tile so it keeps its quiet zone on the soft panel
  const tile = qrSize + 2 * 8;
  const tileX = MARGIN + CONTENT_W - pad - tile;
  const tileTop = y + pad + 4;
  rect(tileX, tileTop, tile, tile, WHITE);
  const { size, runs } = qrRuns(model.verification.verifyUrl);
  const mod = qrSize / size;
  for (const r of runs) {
    page.drawRectangle({ x: tileX + 8 + r.col * mod, y: A4.h - tileTop - 8 - (r.row + 1) * mod, width: r.len * mod, height: mod, color: INK });
  }

  const textW = tileX - (MARGIN + pad) - 14;
  let ty = y + pad + 12;
  const row = (label: string, value: string | null, font: PDFFont, size: number) => {
    text(label.toUpperCase(), MARGIN + pad, ty, 7, fonts.bold, GREY);
    ty += 10;
    const lines = wrapText(clean(value ?? 'Not available'), font, size, textW);
    lines.forEach((l) => {
      text(l, MARGIN + pad, ty, size, font, value ? INK : GREY);
      ty += size + 2.5;
    });
    ty += 5;
  };
  row('Quote signing key id', model.verification.quoteKeyId, fonts.mono, 8);
  if (model.approval?.deviceKeyFingerprint) row('Approver device key fingerprint', model.approval.deviceKeyFingerprint, fonts.mono, 8);
  row('Audit chain head hash (this order)', model.verification.auditHeadHash, fonts.mono, 7.5);
  row('Verify at', model.verification.verifyUrl, fonts.regular, 8);
  text('Scan to verify this order', tileX, tileTop + tile + 4, 8, fonts.bold, PETROL);
  y += blockH + 10;

  // --- Footer and page numbers on every page
  const pages = pdf.getPages();
  pages.forEach((p, i) => {
    p.drawLine({ start: { x: MARGIN, y: FOOTER_H }, end: { x: MARGIN + CONTENT_W, y: FOOTER_H }, thickness: 0.5, color: HAIR });
    p.drawText(clean(model.footer), { x: MARGIN, y: FOOTER_H - 16, size: 8, font: fonts.regular, color: GREY });
    const label = `Page ${i + 1} of ${pages.length}`;
    p.drawText(label, { x: MARGIN + CONTENT_W - fonts.regular.widthOfTextAtSize(label, 8), y: FOOTER_H - 16, size: 8, font: fonts.regular, color: GREY });
    p.drawText(clean(`Order ${model.orderShortId}`), { x: MARGIN, y: FOOTER_H - 28, size: 7, font: fonts.regular, color: GREY });
  });

  return pdf.save({ useObjectStreams: false });
}
