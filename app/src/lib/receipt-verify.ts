import { canonicalJson, decisionText, eventHashInput, offerPayload, type DecisionPayload } from './receipt-canon.ts';
import type { ApproverSignature, PublicJwk, ReceiptBundle, ReceiptCheck } from '../types/index.ts';

// Pure. Everything a receipt check needs, on WebCrypto only (`globalThis.crypto.subtle`), so the same functions run in
// the /verify page, on the server (to reject a bad approver signature) and in tests. Nothing here trusts Valio's server:
// the caller supplies the public keys.

const subtle = () => globalThis.crypto.subtle;
const utf8 = (text: string) => new TextEncoder().encode(text);

export function b64uToBytes(value: string): Uint8Array<ArrayBuffer> {
  const bin = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function bytesToB64u(bytes: ArrayBuffer | Uint8Array): string {
  let bin = '';
  for (const b of new Uint8Array(bytes instanceof Uint8Array ? bytes.buffer : bytes, bytes instanceof Uint8Array ? bytes.byteOffset : 0, bytes.byteLength)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256Hex(text: string): Promise<string> {
  return [...new Uint8Array(await subtle().digest('SHA-256', utf8(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Only the members the key is defined by: extra ones (`kid`, `use`, `alg`) make some runtimes refuse the import. */
const bare = (k: PublicJwk) => (k.crv === 'Ed25519' ? { kty: k.kty, crv: k.crv, x: k.x } : { kty: k.kty, crv: k.crv, x: k.x, y: k.y });

/** True when `signature` (base64url) is Valio's Ed25519 signature over `text`. False for any bad input; throws only if the runtime lacks Ed25519. */
export async function verifyEd25519(text: string, signature: string, publicKey: PublicJwk): Promise<boolean> {
  let key: CryptoKey;
  try {
    key = await subtle().importKey('jwk', bare(publicKey), { name: 'Ed25519' }, false, ['verify']);
  } catch (err) {
    if ((err as { name?: string }).name === 'NotSupportedError') throw new Error('This browser cannot check Ed25519 signatures. Use a current Chrome, Safari or Firefox.');
    return false;
  }
  try {
    return await subtle().verify({ name: 'Ed25519' }, key, b64uToBytes(signature), utf8(text));
  } catch {
    return false;
  }
}

/** True when the device key signed exactly this decision. */
export async function verifyApproverSignature(sig: ApproverSignature): Promise<boolean> {
  try {
    const key = await subtle().importKey('jwk', bare(sig.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return await subtle().verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b64uToBytes(sig.value), utf8(decisionText(sig.payload)));
  } catch {
    return false;
  }
}

/** Signs a decision with a P-256 key. Returns the base64url signature stored beside the payload. */
export async function signDecision(payload: DecisionPayload, privateKey: CryptoKey): Promise<string> {
  return bytesToB64u(await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, utf8(decisionText(payload))));
}

export const mandateHash = (snapshot: ReceiptBundle['mandate']['snapshot']) => sha256Hex(canonicalJson(snapshot));

// --- the checks ---------------------------------------------------------------

type Result = Pick<ReceiptCheck, 'status' | 'detail'>;
const pass = (detail: string): Result => ({ status: 'pass', detail });
const fail = (detail: string): Result => ({ status: 'fail', detail });

/** Looks up a public key by its id: from the JWKS the server publishes, or one the person pinned. */
export type FindKey = (keyId: string) => Promise<PublicJwk | null>;

const keyNotFound = (keyId: string) => fail(`No public key with id ${keyId}. Paste Valio's key to check against.`);

async function checkSignature(text: string, sig: { keyId: string; value: string }, findKey: FindKey, what: string): Promise<Result> {
  const key = await findKey(sig.keyId);
  if (!key) return keyNotFound(sig.keyId);
  return (await verifyEd25519(text, sig.value, key)) ? pass(`${what} matches key ${sig.keyId}.`) : fail(`${what} does not match key ${sig.keyId}.`);
}

/** Order, quote, mandate and policy have to describe the same purchase. */
export function checkMatch(b: ReceiptBundle): Result {
  const { order, quote } = b;
  const problems: string[] = [];
  const same = (name: string, a: unknown, c: unknown) => {
    if (canonicalJson(a) !== canonicalJson(c)) problems.push(name);
  };
  same('quote id', order.quoteId, quote.id);
  same('mandate', [order.mandateId, quote.mandateId], [b.mandate.snapshot.id, b.mandate.snapshot.id]);
  same('delivery date', order.deliveryDate, quote.deliveryDate);
  same('currency', order.currency, quote.currency);
  same('total', [order.total, order.totalWithTax], [quote.total, quote.totalWithTax]);
  const terms = (l: ReceiptBundle['quote']['lines'][number]) => [l.productId, l.quantity, l.salesUnit, l.unitPrice, l.lineTotal];
  same('lines', order.lines.map(terms), quote.lines.map(terms));
  same('reasons', order.policyReasons, b.policy.reasons);
  if (b.decision) {
    same('decision', [b.decision.status === 'approved' ? 'confirmed' : 'rejected', b.decision.decidedBy], [order.status, order.decidedBy]);
  }
  return problems.length === 0 ? pass('Order, quote, mandate and policy agree.') : fail(`These differ between order and quote: ${problems.join(', ')}.`);
}

const isStub = (e: ReceiptBundle['audit']['events'][number]): e is Extract<typeof e, { omitted: true }> => 'omitted' in e && e.omitted === true;

/** Recomputes every event's hash and, where the chain is exported whole, every link. */
export async function checkAudit(b: ReceiptBundle): Promise<Result> {
  const { events, linked } = b.audit;
  let own = 0;
  let links = 0;
  let prevId: bigint | null = null;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (prevId !== null && BigInt(e.id) <= prevId) return fail(`Event ${e.id} is out of order.`);
    prevId = BigInt(e.id);
    if (!isStub(e)) {
      if (e.hash === null) return fail(`Event ${e.id} has no hash.`);
      if ((await sha256Hex(eventHashInput(e.prevHash, e))) !== e.hash) return fail(`Event ${e.id} was changed after it was recorded.`);
      if (e.quoteId !== b.quote.id && e.orderId !== b.order.id) return fail(`Event ${e.id} belongs to another order.`);
      own++;
    }
    if (i > 0 && linked) {
      if (e.prevHash !== events[i - 1].hash) return fail(`Event ${e.id} does not follow the one before it: an event was removed or reordered.`);
      links++;
    }
  }
  if (!events.some((e) => !isStub(e) && e.orderId === b.order.id)) return fail('The record has no event for this order.');
  const hidden = events.length - own;
  return pass(
    `${own} event${own === 1 ? '' : 's'} recomputed` +
      (linked ? `, ${links} links hold${hidden ? ` (${hidden} in between shown as hashes only)` : ''}.` : ', not linked: events in between were not exported.')
  );
}

export async function checkApprover(b: ReceiptBundle): Promise<Result> {
  if (!b.decision) return { status: 'skip', detail: 'No human decision: the mandate decided alone.' };
  const sig = b.decision.approverSignature;
  if (!sig) return { status: 'skip', detail: `${b.decision.decidedBy}'s decision was recorded without a signature.` };
  const p = sig.payload;
  const wanted = [b.order.id, b.decision.status === 'approved' ? 'approve' : 'decline', b.decision.decidedBy, b.decision.note];
  if (canonicalJson([p.orderId, p.decision, p.decidedBy, p.note]) !== canonicalJson(wanted)) return fail('The signed decision is not the decision recorded.');
  return (await verifyApproverSignature(sig)) ? pass(`Signed by device key ${sig.publicKey.x.slice(0, 8)}…, not tied to a verified identity.`) : fail('The approver signature does not match the decision.');
}

/** Runs every check. A malformed bundle fails the check it breaks instead of throwing. */
export async function verifyReceipt(bundle: ReceiptBundle, findKey: FindKey): Promise<{ ok: boolean; checks: ReceiptCheck[] }> {
  if (bundle?.version !== 1) {
    return { ok: false, checks: [{ id: 'bundle', label: 'Valio signature', ...fail('Not a version 1 receipt.') }] };
  }
  const run = async (id: ReceiptCheck['id'], label: string, f: () => Promise<Result> | Result): Promise<ReceiptCheck> => {
    try {
      return { id, label, ...(await f()) };
    } catch (err) {
      return { id, label, ...fail(err instanceof Error && /Ed25519/.test(err.message) ? err.message : 'The receipt is malformed here.') };
    }
  };
  const { signature, ...unsigned } = bundle;
  const checks = await Promise.all([
    run('bundle', 'Valio signature', () => checkSignature(canonicalJson(unsigned), signature, findKey, 'The receipt')),
    run('quote', 'Quote signature', () => {
      if (!bundle.quote.signature) return fail('The quote carries no signature.');
      return checkSignature(offerPayload(bundle.quote), bundle.quote.signature, findKey, 'The quote');
    }),
    run('match', 'Order matches quote', () => checkMatch(bundle)),
    run('mandate', 'Mandate hash', async () =>
      (await mandateHash(bundle.mandate.snapshot)) === bundle.mandate.hash ? pass('The mandate fields match their hash.') : fail('The mandate fields do not match their hash.')
    ),
    run('audit', 'Audit chain', () => checkAudit(bundle)),
    run('approver', 'Approver signature', () => checkApprover(bundle)),
  ]);
  return { ok: checks.every((c) => c.status !== 'fail'), checks };
}
