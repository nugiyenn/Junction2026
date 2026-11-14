'use client';

import { useEffect, useRef, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Page, Panel, Pill } from '@/components/page';
import { verifyReceipt, type FindKey } from '@/lib/receipt-verify';
import type { PublicJwk, ReceiptBundle, ReceiptCheck } from '@/types';

const TONE = { pass: 'ok', fail: 'bad', skip: 'warn' } as const;
const WORD = { pass: 'PASS', fail: 'FAIL', skip: 'N/A' } as const;

/** Reads a pasted JWK or JWKS. Empty text means "use the keys the server publishes". */
function pinnedKeys(text: string): PublicJwk[] | null {
  if (!text.trim()) return null;
  const parsed = JSON.parse(text);
  return Array.isArray(parsed.keys) ? parsed.keys : [parsed];
}

/**
 * Checks a receipt in this browser. Nothing is sent to the server except the request for its public keys, and, when the
 * page is opened with `?order=<id>` (the QR code on an order confirmation), the request for that order's receipt.
 */
export function VerifyView({ orderId }: { orderId?: string }) {
  const [text, setText] = useState('');
  const [pinned, setPinned] = useState('');
  const [checks, setChecks] = useState<ReceiptCheck[] | null>(null);
  const [summary, setSummary] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const autoRan = useRef(false);

  const reset = () => {
    setChecks(null);
    setError(null);
  };

  async function verify(source = text) {
    reset();
    setBusy(true);
    try {
      let bundle: ReceiptBundle;
      try {
        bundle = JSON.parse(source);
      } catch {
        throw new Error('That is not JSON. Paste a receipt downloaded from an order.');
      }
      let keys = pinnedKeys(pinned);
      const findKey: FindKey = async (kid) => {
        if (keys) return keys.find((k) => k.kid === kid) ?? (keys.length === 1 ? keys[0] : null);
        const res = await fetch('/.well-known/jwks.json');
        if (!res.ok) throw new Error('Could not fetch Valio\'s public keys. Paste one to check against.');
        keys = ((await res.json()) as { keys: PublicJwk[] }).keys;
        return keys.find((k) => k.kid === kid) ?? null;
      };
      const result = await verifyReceipt(bundle, findKey);
      setChecks(result.checks);
      setSummary(`Order ${bundle.order?.id?.slice(0, 8) ?? '?'} · ${bundle.order?.total ?? '?'} ${bundle.order?.currency ?? ''} ex VAT`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // Deep link from an order confirmation: load that order's receipt and run the same check as a pasted one.
  useEffect(() => {
    if (!orderId || autoRan.current) return;
    autoRan.current = true;
    (async () => {
      setBusy(true);
      try {
        const res = await fetch(`/api/orders/${orderId}/receipt`);
        const body = await res.text();
        if (!res.ok) {
          let message = `Could not load the receipt for order ${orderId.slice(0, 8)} (HTTP ${res.status}).`;
          try {
            message = JSON.parse(body).error ?? message;
          } catch {
            // not JSON: keep the plain message
          }
          throw new Error(message);
        }
        setText(body);
        await verify(body);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setBusy(false);
      }
    })();
    // verify reads only state setters and the pinned key, and this runs once per page load
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId]);

  /** Adds 1 to the order total, so a failure can be seen without editing JSON by hand. */
  function edit() {
    reset();
    try {
      const bundle = JSON.parse(text);
      if (typeof bundle?.order?.total !== 'number') throw new Error('No order total to change.');
      bundle.order.total += 1;
      setText(JSON.stringify(bundle, null, 2));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Paste a receipt first.');
    }
  }

  const ok = checks?.every((c) => c.status !== 'fail');
  const unchecked = checks?.filter((c) => c.status === 'skip') ?? [];

  return (
    <Page title="Verify a receipt">
      {orderId && (
        <p className="text-sm text-muted-foreground" data-testid="verify-order">
          Verifying order <strong className="font-mono text-foreground">{orderId.slice(0, 8)}</strong> from its order confirmation. The receipt is loaded from this server and checked in this browser.
        </p>
      )}
      <Panel className="flex flex-col gap-3.5">
        <label htmlFor="bundle" className="text-sm font-medium">
          Receipt (JSON)
        </label>
        <textarea
          id="bundle"
          className="min-h-48 w-full rounded-[10px] border border-input bg-card px-3 py-2.5 font-mono text-xs leading-relaxed"
          placeholder="Paste a receipt, or upload the file"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            reset();
          }}
          spellCheck={false}
        />
        <div className="flex flex-wrap items-center gap-2.5">
          <Button className="h-11 px-5" onClick={() => verify()} disabled={busy || !text.trim()}>
            {busy ? 'Checking…' : 'Verify'}
          </Button>
          <input
            ref={file}
            type="file"
            accept="application/json,.json"
            className="hidden"
            aria-label="Upload receipt"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) {
                setText(await f.text());
                reset();
              }
              e.target.value = '';
            }}
          />
          <Button variant="outline" className="h-11 px-4" onClick={() => file.current?.click()}>
            Upload file
          </Button>
          <Button variant="outline" className="h-11 px-4" onClick={edit} disabled={!text.trim()}>
            Edit a value
          </Button>
        </div>
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">Check against a key you hold (optional)</summary>
          <textarea
            className="mt-2.5 min-h-24 w-full rounded-[10px] border border-input bg-card px-3 py-2.5 font-mono text-xs"
            placeholder='Valio&apos;s public key as JSON, e.g. {"kty":"OKP","crv":"Ed25519","x":"…"}. Left empty, the keys come from /.well-known/jwks.json on this server.'
            value={pinned}
            onChange={(e) => {
              setPinned(e.target.value);
              reset();
            }}
            spellCheck={false}
          />
        </details>
      </Panel>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Could not check</AlertTitle>
          <AlertDescription className="break-words">{error}</AlertDescription>
        </Alert>
      )}

      {checks && (
        <Panel className="flex flex-col gap-3.5" aria-label="Result">
          <div className="flex flex-wrap items-center justify-between gap-2.5">
            <Pill tone={ok ? 'ok' : 'bad'} large>
              {ok ? 'Receipt verifies' : 'Does not verify'}
            </Pill>
            <p className="text-xs text-muted-foreground">{summary}</p>
          </div>
          <ul className="flex flex-col divide-y">
            {checks.map((c) => (
              <li key={c.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 py-2.5">
                <Pill tone={TONE[c.status]} className="w-14 justify-center">
                  {WORD[c.status]}
                </Pill>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-sm font-medium">{c.label}</span>
                  <span className="text-[13px] break-words text-muted-foreground">{c.detail}</span>
                </div>
              </li>
            ))}
          </ul>
          {ok && unchecked.length > 0 && <p className="text-[13px] text-muted-foreground">Not checked: {unchecked.map((c) => c.label.toLowerCase()).join(', ')}.</p>}
        </Panel>
      )}

      <details className="rounded-xl border bg-card">
        <summary className="cursor-pointer px-5 py-3.5 text-sm font-medium">What a pass proves</summary>
        <div className="flex flex-col gap-2 border-t px-5 py-4 text-[13px] text-muted-foreground">
          <p>
            Every check ran in this browser with WebCrypto. A pass means the receipt is exactly what Valio signed, the quote terms are
            the ones Valio signed, the audit events still hash and link as recorded, and the approver&apos;s device signed the decision shown.
          </p>
          <p>
            It does not prove the public key is Valio&apos;s: unless you paste a key you obtained another way, it comes from this server, which
            could swap it. The hash chain shows tampering; it does not prevent it, and a chain Valio rewrote end to end would still be
            self-consistent. The approver signature is a device key, not an identity: it shows the same browser signed, not who held it.
            The mandate is shown as it was when the receipt was made, because mandates keep no history.
          </p>
        </div>
      </details>
    </Page>
  );
}
