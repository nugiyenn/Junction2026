import { signDecision } from '@/lib/receipt-verify';
import type { ApproverSignature, PublicJwk } from '@/types';

// A device key: an ECDSA P-256 key made once in this browser and kept in localStorage. It shows that two decisions came
// from the same browser, nothing more. It is not an identity, and no key registry says whose it is.

const STORE = 'approver-device-key';

interface Stored {
  privateJwk: JsonWebKey;
  publicJwk: PublicJwk;
}

let cached: { privateKey: CryptoKey; publicKey: PublicJwk } | undefined;

const read = (): Stored | null => {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? 'null');
  } catch {
    return null;
  }
};

async function deviceKey() {
  if (cached) return cached;
  const subtle = crypto.subtle;
  let stored = read();
  if (!stored) {
    const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const { kty, crv, x, y } = (await subtle.exportKey('jwk', pair.publicKey)) as PublicJwk;
    stored = { privateJwk: await subtle.exportKey('jwk', pair.privateKey), publicJwk: { kty, crv, x, y } };
    try {
      localStorage.setItem(STORE, JSON.stringify(stored));
    } catch {
      // storage blocked: the key lasts until the page is closed
    }
  }
  const privateKey = await subtle.importKey('jwk', stored.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  cached = { privateKey, publicKey: stored.publicJwk };
  return cached;
}

/**
 * The `signature` field for the decision route, or nothing when this browser cannot sign (no WebCrypto, which needs a
 * secure context). The decision then goes through unsigned and the receipt says so.
 */
export async function signedDecision(
  orderId: string,
  decision: 'approve' | 'decline',
  decidedBy: string,
  note?: string
): Promise<{ signature?: Pick<ApproverSignature, 'payload' | 'value' | 'publicKey'> }> {
  try {
    const { privateKey, publicKey } = await deviceKey();
    const payload = { orderId, decision, decidedBy, note: note ?? null, signedAt: new Date().toISOString() };
    return { signature: { payload, value: await signDecision(payload, privateKey), publicKey } };
  } catch {
    return {};
  }
}
