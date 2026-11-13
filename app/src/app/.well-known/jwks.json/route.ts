import { errorResponse } from '@/lib/http';
import { publicKeys } from '@/lib/signing';

/**
 * GET /.well-known/jwks.json
 * Valio's public keys (Ed25519, JWK). An agent verifies a quote's `signature.value` over the canonical offer terms
 * with the key whose `kid` equals `signature.keyId`, without calling Valio again.
 */
export async function GET() {
  try {
    return Response.json({ keys: await publicKeys() }, { headers: { 'Cache-Control': 'public, max-age=300' } });
  } catch (err) {
    return errorResponse(err);
  }
}
