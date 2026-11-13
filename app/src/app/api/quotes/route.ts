import { z } from 'zod';
import { errorResponse } from '@/lib/http';
import { createQuote } from '@/lib/purchasing';

const Body = z.object({
  mandateId: z.string().min(1),
  deliveryDate: z.iso.date(),
  lines: z
    .array(z.object({ productId: z.string().min(1), quantity: z.number().positive() }))
    .min(1)
    .max(100),
});

/**
 * POST /api/quotes  { mandateId, deliveryDate: "YYYY-MM-DD", lines: [{ productId, quantity }] }
 * Returns live price and availability per line, held until `expiresAt`. Quantities are in sales units.
 */
export async function POST(request: Request) {
  try {
    const quote = await createQuote(Body.parse(await request.json()));
    return Response.json({ quote }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
