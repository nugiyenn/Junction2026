import { z } from 'zod';
import { buildConfirmationModel, contextFromReceipt } from '@/lib/confirmation';
import { renderConfirmationPdf } from '@/lib/confirmation-pdf';
import { errorResponse } from '@/lib/http';
import { getReceipt } from '@/lib/receipt';
import { getOrder } from '@/lib/purchasing';
import { enforceRateLimit } from '@/lib/ratelimit';

/**
 * GET /api/orders/:id/confirmation
 * The order as a printable PDF: an order confirmation (not an invoice) with the lines, the total ex VAT, the mandate decision
 * and a verification block with a QR code that opens /verify for this order. It holds only what the buyer already sees in a
 * quote or order. Confirmed and waiting orders carry their status; a declined or rejected order gets the same document with
 * the status "Declined". Rate limited per mandate, like the other order reads that cost work.
 */
export async function GET(request: Request, ctx: RouteContext<'/api/orders/[id]/confirmation'>) {
  try {
    const id = z.uuid().parse((await ctx.params).id);
    // Unknown ids get the receipt route's 404 here, before any rate-limit count or PDF work.
    const rateHeaders = await enforceRateLimit('quotes', (await getOrder(id)).mandateId);
    const receipt = await getReceipt(id);
    const model = buildConfirmationModel(receipt.order, contextFromReceipt(receipt, new URL(request.url).origin));
    const pdf = await renderConfirmationPdf(model);
    return new Response(pdf as BodyInit, {
      headers: {
        ...rateHeaders,
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="order-confirmation-${model.orderShortId}.pdf"`,
        'Content-Length': String(pdf.byteLength),
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
