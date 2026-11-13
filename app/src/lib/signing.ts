import 'server-only';
import { getPool } from '@/lib/db';
import { generateSigningKey, offerPayload, signPayload, toJwk, verifyPayload } from '@/lib/offer-signature';
import type { Quote } from '@/types';

// Valio's signing key lives in the database so it survives restarts and deployments. This is a mock: a real
// deployment would hold the private key in a KMS or HSM and rotate it, publishing old public keys until their
// last quote has expired.

interface KeyRow {
  kid: string;
  private_pem: string;
  public_pem: string;
}

let cached: KeyRow | undefined;

async function currentKey(): Promise<KeyRow> {
  if (cached) return cached;
  const pool = getPool();
  const newest = () => pool.query<KeyRow>('SELECT kid, private_pem, public_pem FROM signing_keys ORDER BY created_at DESC LIMIT 1');

  let { rows } = await newest();
  if (rows.length === 0) {
    const { privatePem, publicPem } = generateSigningKey();
    const kid = `valio-aimo-mock-${new Date().toISOString().slice(0, 10)}`;
    // Two first requests at once: one insert wins, both then read the same key.
    await pool.query('INSERT INTO signing_keys (kid, private_pem, public_pem) VALUES ($1, $2, $3) ON CONFLICT (kid) DO NOTHING', [kid, privatePem, publicPem]);
    ({ rows } = await newest());
  }
  cached = rows[0];
  return cached;
}

/** Signs a quote's commercial terms. Returns what is stored with the quote. */
export async function signQuote(quote: Quote): Promise<NonNullable<Quote['signature']>> {
  const key = await currentKey();
  return { alg: 'EdDSA', keyId: key.kid, value: signPayload(offerPayload(quote), key.private_pem) };
}

/** True only if the stored signature matches the quote as it is now, under the key it names. */
export async function verifyQuoteSignature(quote: Quote): Promise<boolean> {
  if (!quote.signature) return false;
  const { rows } = await getPool().query<KeyRow>('SELECT kid, private_pem, public_pem FROM signing_keys WHERE kid = $1', [quote.signature.keyId]);
  if (rows.length === 0) return false;
  return verifyPayload(offerPayload(quote), quote.signature.value, rows[0].public_pem);
}

/** Every public key, in the form published at /.well-known/jwks.json. */
export async function publicKeys() {
  await currentKey();
  const { rows } = await getPool().query<KeyRow>('SELECT kid, private_pem, public_pem FROM signing_keys ORDER BY created_at DESC');
  return rows.map((r) => toJwk(r.public_pem, r.kid));
}
