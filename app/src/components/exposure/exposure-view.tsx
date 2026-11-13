'use client';

import { useEffect, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { call, eur } from '@/components/flow/api';
import type { ExposedQuote, Quote } from '@/types';

interface Views {
  internal: Quote;
  agent: ExposedQuote;
  signatureValid: boolean;
}

function Row({ label, value, withheld }: { label: string; value?: React.ReactNode; withheld?: boolean }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={withheld ? 'italic text-muted-foreground line-through decoration-dotted' : ''}>
        {withheld ? 'withheld from the agent' : value}
      </dd>
    </>
  );
}

const CONFIDENCE = { confirmed: 'confirmed stock', supplier_unconfirmed: 'supplier ships it, quantity unknown', unknown: 'unknown' };

/** Valio's data next to the agent's view of it: the exposure policy made visible. */
export function ExposureView({ quoteId }: { quoteId: string }) {
  const [views, setViews] = useState<Views | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    call<Views>(`/api/quotes/${quoteId}/views`)
      .then((v) => !cancelled && setViews(v))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [quoteId]);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">What an agent can see</h1>
        <p className="text-muted-foreground">
          The same quote, as Valio holds it and as the buyer&apos;s agent receives it. The agent gets its own fixed price and
          whether Valio can fill the request. It does not get the stock, the list price, the discount or the supplier.
        </p>
      </header>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Could not load the quote</AlertTitle>
          <AlertDescription className="break-words">
            {error} Run a request on the Buyer agent page first, then follow the link under step 3.
          </AlertDescription>
        </Alert>
      )}

      {views && (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>What Valio knows</CardTitle>
                <CardDescription>Internal: never leaves Valio.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4 text-sm">
                {views.internal.lines.map((l) => (
                  <div key={l.productId} className="flex flex-col gap-1.5">
                    <div className="font-medium">{l.name}</div>
                    <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1">
                      <Row label="Buyer's price" value={`${eur(l.unitPrice)} per ${l.salesUnit}`} />
                      <Row label="List price" value={eur(l.internal?.listPrice)} />
                      <Row label="Discount" value={l.internal?.discountPct == null ? '–' : `${l.internal.discountPct}%`} />
                      <Row label="Price basis" value={l.internal?.netPriceFound ? 'customer-specific net price' : 'catalog price'} />
                      <Row
                        label="Stock"
                        value={
                          l.internal?.availableAmount != null
                            ? `${l.internal.availableAmount} ${l.salesUnit}`
                            : l.logisticModel === 'Terminal'
                              ? 'unknown to Valio (supplier ships it)'
                              : 'in stock, no limit reported'
                        }
                      />
                      <Row label="Supplier" value={l.internal?.vendorName ?? '–'} />
                      <Row label="Category code" value={l.internal?.category ?? '–'} />
                    </dl>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>What the agent receives</CardTitle>
                <CardDescription>Scoped to what it needs to decide and order.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4 text-sm">
                {views.agent.lines.map((l) => (
                  <div key={l.productId} className="flex flex-col gap-1.5">
                    <div className="font-medium">{l.name}</div>
                    <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1">
                      <Row label="Buyer's price" value={`${eur(l.unitPrice)} per ${l.salesUnit}`} />
                      <Row label="List price" withheld />
                      <Row label="Discount" withheld />
                      <Row label="Price basis" withheld />
                      <Row
                        label="Stock"
                        value={
                          <span className="flex flex-wrap gap-1">
                            <Badge variant={l.stock.canFill ? 'default' : 'destructive'}>{l.stock.canFill ? 'can fill' : 'cannot fill'}</Badge>
                            <Badge variant="outline">{CONFIDENCE[l.stock.confidence]}</Badge>
                            <Badge variant="outline">level: {l.stock.level}</Badge>
                          </span>
                        }
                      />
                      <Row label="Supplier" withheld />
                      <Row label="Category code" withheld />
                    </dl>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2">
                Signed by Valio
                <Badge variant={views.signatureValid ? 'default' : 'destructive'}>{views.signatureValid ? 'Signature valid' : 'Signature invalid'}</Badge>
              </CardTitle>
              <CardDescription>
                The signature covers the price, quantities, delivery date and validity, and nothing private, so the agent can verify
                the offer without calling Valio.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 text-sm">
              {views.agent.signature ? (
                <>
                  <p>
                    Algorithm {views.agent.signature.alg} · key <code>{views.agent.signature.keyId}</code> · valid until{' '}
                    {new Date(views.agent.expiresAt).toLocaleTimeString('en-GB')}
                  </p>
                  <p className="break-all font-mono text-xs text-muted-foreground">{views.agent.signature.value}</p>
                  <p className="text-muted-foreground">
                    Public key: <a className="underline" href="/.well-known/jwks.json" target="_blank" rel="noreferrer">/.well-known/jwks.json</a>
                  </p>
                </>
              ) : (
                <p className="text-muted-foreground">This quote was issued before signing existed.</p>
              )}
              <details>
                <summary className="cursor-pointer text-muted-foreground">The agent&apos;s JSON</summary>
                <pre className="mt-2 max-h-96 overflow-auto rounded-md bg-muted p-3 text-xs">{JSON.stringify(views.agent, null, 2)}</pre>
              </details>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
