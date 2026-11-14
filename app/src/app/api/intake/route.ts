import { z } from 'zod';
import { errorResponse, HttpError } from '@/lib/http';
import { enforceRateLimit } from '@/lib/ratelimit';
import { checkImage, MAX_IMAGE_BYTES, readIntakeImage } from '@/lib/vision';

/** One vision call (40 s deadline, a few quick retries on 429/5xx). */
export const maxDuration = 60;

const Body = z.object({ image: z.string().min(1) });

/**
 * POST /api/intake  { image: "data:image/jpeg;base64,..." }
 * Nemotron's vision side reads a photo (a handwritten list, a shelf, an invoice) into candidate lines.
 * The route only returns lines: nothing is quoted or ordered from them. Rate limited with one shared counter.
 */
export async function POST(request: Request) {
  try {
    // Refuse an oversized body before parsing it.
    if (Number(request.headers.get('content-length')) > MAX_IMAGE_BYTES * 1.4) {
      throw new HttpError(413, `The image is over ${MAX_IMAGE_BYTES / 1_000_000} MB. Send a smaller or downscaled photo.`);
    }
    const { image } = Body.parse(await request.json());
    checkImage(image);
    const headers = await enforceRateLimit('intake', 'shared');
    return Response.json(await readIntakeImage(image), { headers });
  } catch (err) {
    return errorResponse(err);
  }
}
