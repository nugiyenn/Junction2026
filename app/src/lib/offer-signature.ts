import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type JsonWebKey } from 'node:crypto';
import { offerPayload } from './receipt-canon.ts';

export { offerPayload };

// Pure. A quote's price, quantities, delivery date and validity are signed by Valio with Ed25519. An agent can
// check a quote against Valio's published public key, without calling Valio and without trusting the transport.

export function generateSigningKey(): { privatePem: string; publicPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

/** Base64url signature over the payload. */
export function signPayload(payload: string, privatePem: string): string {
  return sign(null, Buffer.from(payload), createPrivateKey(privatePem)).toString('base64url');
}

/** Checks a signature with a public key given as a PEM string or a JWK. False for anything that does not verify. */
export function verifyPayload(payload: string, signature: string, publicKey: string | JsonWebKey): boolean {
  try {
    const key = typeof publicKey === 'string' ? createPublicKey(publicKey) : createPublicKey({ key: publicKey, format: 'jwk' });
    return verify(null, Buffer.from(payload), key, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}

/** The public key in the form published at /.well-known/jwks.json. */
export function toJwk(publicPem: string, keyId: string): JsonWebKey & { kid: string; use: 'sig'; alg: 'EdDSA' } {
  return { ...createPublicKey(publicPem).export({ format: 'jwk' }), kid: keyId, use: 'sig', alg: 'EdDSA' };
}
