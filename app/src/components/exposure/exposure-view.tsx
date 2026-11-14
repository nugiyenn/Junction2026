'use client';

import { useEffect, useState } from 'react';
import { cn } from 'cn';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { call, eur } from '@/components/flow/api';
import { Page, Panel, Pill } from '@/components/page';
import type { ExposedQuote, Quote } from '@/types';

interface Views {
  internal: Quote;
  agent: ExposedQuote;
  signatureValid: boolean;
}

/** The tools an agent can call over MCP. Approving an order and editing a mandate are deliberately absent. */
const TOOLS = ['search_products', 'request_offers', 'create_quote', 'place_order', 'get_order_status', 'verify_product', 'get_mandate'];

function Row({ label, value, withheld }: { label: string; value?: React.ReactNode; withheld?: boolean }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn('text-right', withheld ? 'text-muted-foreground' : 'font-semibold')}>{withheld ? 'Hidden' : value}</dd>
    </>
  );
}

const CONFIDENCE = { confirmed: 'Confirmed stock', supplier_unconfirmed: 'Supplier, qty unknown', unknown: 'Unknown' };

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
    <Page title="What agents see">
      {error && (
        <Alert variant="destructive">
          <AlertTitle>Could not load the quote</AlertTitle>
          <AlertDescription className="break-words">{error} Run a request first.</AlertDescription>
        </Alert>
      )}

      {views && (
        <>
          <div className="flex flex-wrap items-start gap-6">
            <Panel className="flex min-w-0 flex-[1_1_360px] flex-col gap-4">
              <div className="flex items-center justify-between">
                <h2 className="text-[17px] font-semibold">What Valio sees</h2>
                <Pill>Internal</Pill>
              </div>
              {views.internal.lines.map((l) => (
                <div key={l.productId} className="flex flex-col gap-2">
                  <p className="font-medium">{l.name}</p>
                  <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2.5 text-sm">
                    <Row label="Buyer's price" value={`${eur(l.unitPrice)} per ${l.salesUnit}`} />
                    <Row label="List price" value={eur(l.internal?.listPrice)} />
                    <Row label="Discount" value={l.internal?.discountPct == null ? '–' : `${l.internal.discountPct}%`} />
                    <Row label="Price basis" value={l.internal?.netPriceFound ? 'Customer net price' : 'Catalog price'} />
                    <Row
                      label="Stock"
                      value={
                        l.internal?.availableAmount != null
                          ? `${l.internal.availableAmount} ${l.salesUnit}`
                          : l.logisticModel === 'Terminal'
                            ? 'Unknown (supplier)'
                            : 'No limit reported'
                      }
                    />
                    <Row label="Supplier" value={l.internal?.vendorName ?? '–'} />
                    <Row label="Category code" value={l.internal?.category ?? '–'} />
                  </dl>
                </div>
              ))}
            </Panel>

            <Panel className="flex min-w-0 flex-[1_1_360px] flex-col gap-4 border-primary">
              <div className="flex items-center justify-between">
                <h2 className="text-[17px] font-semibold">What the agent sees</h2>
                <Pill tone="ok">Exposed</Pill>
              </div>
              {views.agent.lines.map((l) => (
                <div key={l.productId} className="flex flex-col gap-2">
                  <p className="font-medium">{l.name}</p>
                  <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2.5 text-sm">
                    <Row label="Buyer's price" value={`${eur(l.unitPrice)} per ${l.salesUnit}`} />
                    <Row label="List price" withheld />
                    <Row label="Discount" withheld />
                    <Row label="Price basis" withheld />
                    <Row
                      label="Stock"
                      value={
                        <span className="inline-flex flex-wrap justify-end gap-1">
                          <Pill tone={l.stock.canFill ? 'ok' : 'bad'}>{l.stock.canFill ? 'Can fill' : 'Cannot fill'}</Pill>
                          <Pill>{CONFIDENCE[l.stock.confidence]}</Pill>
                        </span>
                      }
                    />
                    <Row label="Supplier" withheld />
                    <Row label="Category code" withheld />
                  </dl>
                </div>
              ))}
            </Panel>
          </div>

          <Panel className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-[17px] font-semibold">Signature</h2>
              <Pill tone={views.signatureValid ? 'ok' : 'bad'}>{views.signatureValid ? 'Signature valid' : 'Signature invalid'}</Pill>
            </div>
            {views.agent.signature ? (
              <>
                <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                  <dt className="text-muted-foreground">Algorithm</dt>
                  <dd className="text-right font-semibold">{views.agent.signature.alg}</dd>
                  <dt className="text-muted-foreground">Key</dt>
                  <dd className="text-right">
                    <code className="font-mono text-xs">{views.agent.signature.keyId}</code>
                  </dd>
                  <dt className="text-muted-foreground">Valid until</dt>
                  <dd className="text-right">{new Date(views.agent.expiresAt).toLocaleTimeString('en-GB')}</dd>
                  <dt className="text-muted-foreground">Public key</dt>
                  <dd className="text-right">
                    <a className="text-primary underline" href="/.well-known/jwks.json" target="_blank" rel="noreferrer">
                      jwks.json
                    </a>
                  </dd>
                </dl>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Unsigned (issued before signing)</p>
            )}
            <details>
              <summary className="min-h-9 cursor-pointer py-1.5 text-sm text-primary">Signature value and agent JSON</summary>
              <p className="mt-2 text-xs text-muted-foreground">Covers price, quantities, delivery date and validity.</p>
              {views.agent.signature && <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{views.agent.signature.value}</p>}
              <pre className="mt-2 max-h-96 overflow-auto rounded-lg bg-muted p-3 text-xs">{JSON.stringify(views.agent, null, 2)}</pre>
            </details>
          </Panel>
        </>
      )}

      <Panel className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-[1_1_320px] flex-col gap-1">
          <h2 className="text-[17px] font-semibold">MCP tools</h2>
          <p className="text-xs text-muted-foreground">No approve, no mandate edit</p>
        </div>
        <div className="flex flex-[1_1_320px] flex-wrap gap-2">
          {TOOLS.map((t) => (
            <span key={t} className="inline-flex h-7 items-center rounded-full border bg-muted px-3 font-mono text-xs">
              {t}
            </span>
          ))}
        </div>
      </Panel>
    </Page>
  );
}
