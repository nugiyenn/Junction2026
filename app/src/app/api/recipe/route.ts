import { z } from 'zod';
import { errorResponse, HttpError } from '@/lib/http';
import { helsinkiToday, weekdayDate } from '@/lib/interpret';
import { getMandate } from '@/lib/purchasing';
import { enforceRateLimit } from '@/lib/ratelimit';
import { runNamedModelStructured } from '@/lib/llm';
import { defaultDeliveryDate, MAX_RECIPE_CHARS, MAX_RECIPE_LINES } from '@/lib/recipe';
import { matchRecipe } from '@/lib/recipe-match';
import { MODEL_READ_TIMEOUT_MS, ModelLinesSchema, RECIPE_READ_INSTRUCTIONS, readRecipe } from '@/lib/recipe-read';
import { SECOND_READER } from '@/lib/request';
import type { RecipeResult } from '@/types';

/** Searching and pricing 40 lines is bounded to 60 s by the matcher; this leaves room for the rest. */
export const maxDuration = 90;

const Body = z.object({
  mandateId: z.string().min(1),
  text: z.string().min(1).max(MAX_RECIPE_CHARS),
  multiplier: z.number().min(0.01).max(1000).default(1),
  deliveryDate: z.iso.date().optional(),
});

/** A plain sentence for the first thing wrong with the body, never the validator's own wording. */
function badBody(error: z.ZodError): HttpError {
  const field = String(error.issues[0]?.path[0] ?? '');
  const message =
    field === 'mandateId'
      ? 'Choose a mandate first.'
      : field === 'text'
        ? `Paste the recipe as text, at most ${MAX_RECIPE_CHARS} characters. Split a longer list into two orders.`
        : field === 'multiplier'
          ? 'The portions factor must be a number from 0.01 to 1000.'
          : field === 'deliveryDate'
            ? 'The delivery date must be written as YYYY-MM-DD, for example 2026-11-20.'
            : 'The request is not complete: send mandateId and text.';
  return new HttpError(400, message);
}

/**
 * POST /api/recipe  { mandateId, text, multiplier?: 1, deliveryDate?: "YYYY-MM-DD" }
 * Reads a pasted recipe or shopping list (code parses it; only prose the parser cannot read goes to a model that splits it into lines), finds a catalog product for each line, and sizes the
 * packs from Valio's live price. Returns one row per line with a status, the proposed product, up to two alternatives, the
 * packs and the line total as a buyer sees them in a quote. Nothing is quoted or ordered: send the lines the buyer keeps
 * to POST /api/quotes. Rate limited per mandate.
 */
export async function POST(request: Request) {
  try {
    const parsed = Body.safeParse(await request.json());
    if (!parsed.success) throw badBody(parsed.error);
    const { mandateId, text, multiplier } = parsed.data;

    // Before any model call: it spends quota.
    const headers = await enforceRateLimit('recipe', mandateId);

    // Code reads the text. Only prose it cannot read goes to a model, which only splits it into lines.
    const { lines, skipped, usedModel, modelFailed } = await readRecipe(text, (t) =>
      runNamedModelStructured(SECOND_READER.id, RECIPE_READ_INSTRUCTIONS, t, ModelLinesSchema, { timeoutMs: MODEL_READ_TIMEOUT_MS })
    );
    if (lines.length === 0) {
      throw new HttpError(
        422,
        'No ingredient lines could be read. Write one per line with an amount and a unit, for example "20 kg mozzarella" or "0,5 l cream".'
      );
    }
    if (lines.length > MAX_RECIPE_LINES) {
      throw new HttpError(422, `This recipe has ${lines.length} lines. An order covers at most ${MAX_RECIPE_LINES}: split it into two.`);
    }

    const today = helsinkiToday();
    const fromText = parsed.data.deliveryDate ? null : weekdayDate(text, today.date);
    const deliveryDate = parsed.data.deliveryDate ?? fromText ?? defaultDeliveryDate(today.date);
    if (deliveryDate < today.date) throw new HttpError(422, `The delivery date ${deliveryDate} is in the past.`);

    const mandate = await getMandate(mandateId);
    const matched = await matchRecipe(lines, { mandate, deliveryDate, multiplier });

    const count = (status: string) => matched.filter((l) => l.status === status).length;
    const notes: string[] = [];
    notes.push(
      parsed.data.deliveryDate
        ? `Delivery on ${deliveryDate}.`
        : fromText
          ? `Delivery on ${deliveryDate}, read from the weekday in the text.`
          : `No delivery date given: proposing ${deliveryDate}, the first weekday at least 3 days ahead.`
    );
    if (multiplier !== 1) notes.push(`Every amount was multiplied by ${multiplier}.`);
    const notOrdered = matched.filter((l) => l.notOrdered).length;
    const notInRange = count('not_found') - notOrdered;
    if (notInRange > 0) notes.push(`${notInRange} line(s) are not in Valio's range and are left out of the order.`);
    if (notOrdered > 0) notes.push(`${notOrdered} line(s) are not ordered (water and ice).`);
    if (count('unpriced') > 0) notes.push(`${count('unpriced')} line(s) have no price yet. The others are priced.`);
    if (count('weak') > 0) notes.push(`${count('weak')} line(s) fit only partly: check the product before you order.`);
    if (usedModel) {
      notes.push('Read by a model, not by the parser: check each line. Anything in the text without an amount was left out.');
    } else if (modelFailed) {
      notes.push('Some text could not be read, and the model that tries to read prose did not answer.');
    }
    if (skipped.length > 0) notes.push(`${skipped.length} line(s) could not be read as an amount with a name.`);

    const result: RecipeResult = { lines: matched, readByModel: usedModel, skipped, deliveryDate, multiplier, notes };
    return Response.json(result, { headers });
  } catch (err) {
    return errorResponse(err);
  }
}
