import { z } from 'zod';
import { exposeQuote } from '@/lib/exposure';
import { errorResponse } from '@/lib/http';
import { createQuote, previewPolicy } from '@/lib/purchasing';

const Body = z.object({
  mandateId: z.string().min(1),
  deliveryDate: z.iso.date(),
  lines: z
    .array(z.object({ productId: z.string().min(1), quantity: z.number().positive(), substituteFor: z.string().min(1).optional() }))
    .min(1)
    .max(100),
});

/**
 * POST /api/quotes  { mandateId, deliveryDate: "YYYY-MM-DD", lines: [{ productId, quantity }] }
 * Returns live price and availability per line, held until `expiresAt`. Quantities are in sales units.
 * A line may carry `substituteFor: productId` when it replaces another product; Valio must list it as a substitute.
 * Also returns `policy`: what the buyer's mandate would decide if this quote were ordered now.
 */
export async function POST(request: Request) {
  try {
    const quote = await createQuote(Body.parse(await request.json()));
    return Response.json({ quote: exposeQuote(quote), policy: await previewPolicy(quote) }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
