'use client';

import { useEffect, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { AuditEvent, ExposedOrder, ExposedQuote, Mandate, Offer, OfferKind, Order, RequestResult } from '@/types';
import { call, clock, eur } from './api';
import { MandatePanel } from './mandate-panel';
import { VerifyCheck } from './verify-check';

const SCENARIOS = [
  {
    label: 'Hotel: 1,000 L lactose-free milk',
    mandateId: 'demo-hotel',
    text: 'I need 1,000 litres of lactose-free milk by Monday. Find an option that meets our requirements based on price and availability.',
    expect: 'Over the auto-approve limit, so a human signs off.',
  },
  {
    label: 'Hotel: 100 L top-up',
    mandateId: 'demo-hotel',
    text: 'I need 100 litres of lactose-free milk by Monday.',
    expect: 'Within the limit, so the order confirms by itself.',
  },
  {
    label: 'School: 20 kg granola, no nuts',
    mandateId: 'demo-school',
    text: 'I need 20 kg of granola by Tuesday.',
    expect: 'Products with nut risk are hidden before pricing; a safe one is chosen.',
  },
  {
    label: 'School: 100 kg granola (short stock)',
    mandateId: 'demo-school',
    text: 'I need 100 kg of granola by Tuesday.',
    expect: 'No product has enough stock, so the order is split across products; above the limit, so a human signs off.',
  },
];

const KIND_LABEL: Record<OfferKind, string> = {
  cheapest: 'Cheapest',
  most_reliable: 'Most reliable',
  lowest_co2: 'Lowest CO2',
  split: 'Split across products',
  substitute: 'Substitute',
};

const STATUS_STYLE: Record<Order['status'], { label: string; variant: 'default' | 'secondary' | 'destructive' }> = {
  confirmed: { label: 'Confirmed', variant: 'default' },
  pending_approval: { label: 'Awaiting human approval', variant: 'secondary' },
  rejected: { label: 'Rejected', variant: 'destructive' },
};

function Step({ n, title, description, children }: { n: number; title: string; description?: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span className="flex size-6 items-center justify-center rounded-full bg-primary text-xs text-primary-foreground">{n}</span>
          {title}
        </CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export function PurchaseFlow() {
  const [mandates, setMandates] = useState<Mandate[]>([]);
  const [mandateId, setMandateId] = useState(SCENARIOS[0].mandateId);
  const [text, setText] = useState(SCENARIOS[0].text);
  const [expect, setExpect] = useState<string | null>(SCENARIOS[0].expect);
  const [result, setResult] = useState<RequestResult | null>(null);
  const [order, setOrder] = useState<ExposedOrder | null>(null);
  const [selectedOfferId, setSelectedOfferId] = useState<string | null>(null);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [approver, setApprover] = useState('Purchasing manager');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    call<{ mandates: Mandate[] }>('/api/mandates')
      .then((r) => setMandates(r.mandates))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const mandate = mandates.find((m) => m.id === mandateId) ?? null;

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setError(null);
    try {
      await fn();
      setAudit((await call<{ events: AuditEvent[] }>(`/api/audit?mandateId=${mandateId}`)).events);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const submitRequest = (forMandate = mandateId, forText = text) =>
    run('request', async () => {
      setResult(null);
      setOrder(null);
      const fresh = await call<RequestResult>('/api/requests', { mandateId: forMandate, text: forText });
      setResult(fresh);
      setSelectedOfferId(fresh.offers[0]?.id ?? null);
    });

  function runScenario(s: (typeof SCENARIOS)[number]) {
    setMandateId(s.mandateId);
    setText(s.text);
    setExpect(s.expect);
    void submitRequest(s.mandateId, s.text);
  }

  const chooseOffer = (offer: Offer) =>
    run(`offer-${offer.id}`, async () => {
      const { quote } = await call<{ quote: ExposedQuote }>('/api/quotes', {
        mandateId,
        deliveryDate: result!.interpreted.deliveryDate,
        lines: offer.lines.map((l) => ({ productId: l.productId, quantity: l.quantity, substituteFor: l.substituteFor })),
      });
      setResult((r) => (r ? { ...r, quote } : r));
      setSelectedOfferId(offer.id);
    });

  const placeOrder = () =>
    run('order', async () => {
      setOrder((await call<{ order: ExposedOrder }>('/api/orders', { quoteId: result!.quote!.id })).order);
    });

  const decide = (decision: 'approve' | 'decline') =>
    run(decision, async () => {
      setOrder((await call<{ order: ExposedOrder }>(`/api/orders/${order!.id}/decision`, { decision, decidedBy: approver })).order);
    });

  async function resetDemo() {
    if (!window.confirm('Delete all quotes, orders and the decision record? Mandates and the catalog are kept.')) return;
    await run('reset', async () => {
      await call('/api/demo/reset', {});
      setResult(null);
      setOrder(null);
    });
  }

  const quote = result?.quote ?? null;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">A buyer&apos;s purchasing agent orders from Valio Aimo</h1>
        <p className="text-muted-foreground">
          A language model reads the request; code decides quantities, prices and approval. Everything the agent does stays inside
          the buyer&apos;s mandate.
        </p>
      </header>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Request failed</AlertTitle>
          <AlertDescription className="break-words">{error}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Demo scenarios</CardTitle>
          <CardDescription>One click sends the request through the whole flow.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          {SCENARIOS.map((s) => (
            <Button key={s.label} variant="outline" disabled={busy !== null} onClick={() => runScenario(s)}>
              {s.label}
            </Button>
          ))}
          <Button variant="ghost" className="ml-auto" disabled={busy !== null} onClick={resetDemo}>
            Reset demo data
          </Button>
        </CardContent>
      </Card>

      <Step n={1} title="Request" description="What the buyer's agent asks for, under which mandate.">
        <div className="flex flex-col gap-3">
          <select
            className="h-8 rounded-lg border border-input bg-background px-2 text-sm"
            value={mandateId}
            onChange={(e) => setMandateId(e.target.value)}
          >
            {mandates.map((m) => (
              <option key={m.id} value={m.id}>
                {m.buyerName}
              </option>
            ))}
          </select>
          <textarea
            className="min-h-20 rounded-lg border border-input bg-background p-2 text-sm"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setExpect(null);
            }}
          />
          {expect && <p className="text-xs text-muted-foreground">Expected: {expect}</p>}
          <Button onClick={() => submitRequest()} disabled={busy !== null || text.trim().length < 3} className="self-start">
            {busy === 'request' ? 'Interpreting and pricing…' : 'Send request'}
          </Button>
        </div>
      </Step>

      {mandate && (
        <Card>
          <CardHeader>
            <CardTitle>{mandate.buyerName}&apos;s mandate</CardTitle>
            <CardDescription>What the agent may decide alone. Anything outside it goes to a human or is rejected.</CardDescription>
          </CardHeader>
          <CardContent>
            <MandatePanel
              key={`${mandate.id}-${JSON.stringify(mandate)}`}
              mandate={mandate}
              onSaved={(saved) => {
                setMandates((all) => all.map((m) => (m.id === saved.id ? saved : m)));
                void run('audit', async () => undefined);
              }}
              onError={setError}
            />
          </CardContent>
        </Card>
      )}

      {result && (
        <Step
          n={2}
          title="Lookup"
          description={`Read by ${result.models.interpreted}, matches picked by ${result.models.picked}, then priced live for the shortlist only.`}
        >
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap gap-2 text-sm">
              <Badge variant="outline">{result.interpreted.product}</Badge>
              <Badge variant="outline">
                {result.interpreted.amount} {result.interpreted.amountUnit}
              </Badge>
              <Badge variant="outline">by {result.interpreted.deliveryDate}</Badge>
              {result.interpreted.requiredClaims.map((c) => (
                <Badge key={c} variant="secondary">
                  {c}
                </Badge>
              ))}
            </div>
            {result.excludedByMandate > 0 && (
              <p className="text-sm text-muted-foreground">
                The mandate hid <strong>{result.excludedByMandate}</strong> matching products that contain or may contain a blocked
                allergen, before any price was fetched.
              </p>
            )}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>#</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead>Order</TableHead>
                  <TableHead>Per {result.interpreted.amountUnit}</TableHead>
                  <TableHead>Total ex VAT</TableHead>
                  <TableHead>Stock</TableHead>
                  <TableHead>Why</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.candidates.map((c) => (
                  <TableRow key={c.productId} className={c.fulfillable ? undefined : 'text-muted-foreground'}>
                    <TableCell>{c.rank}</TableCell>
                    <TableCell className="max-w-56 whitespace-normal">
                      {c.name}
                      <div className="text-xs text-muted-foreground">{c.productId}</div>
                    </TableCell>
                    <TableCell>
                      {c.quantity === null ? '–' : `${c.quantity} ${c.salesUnit}`}
                      {c.amountPerUnit !== null && c.amountPerUnit !== 1 && (
                        <div className="text-xs text-muted-foreground">
                          × {c.amountPerUnit} {result.interpreted.amountUnit}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>{eur(c.comparisonPrice)}</TableCell>
                    <TableCell>{eur(c.total)}</TableCell>
                    <TableCell>
                      {c.logisticModel === 'Stock' ? 'Confirmed' : c.logisticModel === 'Terminal' ? 'Supplier, unconfirmed' : '–'}
                    </TableCell>
                    <TableCell className="max-w-64 whitespace-normal text-xs">{c.reasons.join(' ')}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Step>
      )}

      {result && result.notes.length > 0 && (
        <Alert>
          <AlertTitle>Exception handled</AlertTitle>
          <AlertDescription>{result.notes.join(' ')}</AlertDescription>
        </Alert>
      )}

      {result && result.offers.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Offers</CardTitle>
            <CardDescription>
              Ways to fill the request, compared on more than price. The default is the first; choosing another prices it afresh.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-3">
            {result.offers.map((o) => {
              const selected = o.id === selectedOfferId;
              return (
                <div key={o.id} className={`flex flex-col gap-2 rounded-lg border p-3 text-sm ${selected ? 'border-primary ring-1 ring-primary' : ''}`}>
                  <div className="flex flex-wrap gap-1">
                    {o.kinds.map((k) => (
                      <Badge key={k} variant={k === 'substitute' ? 'destructive' : 'secondary'}>
                        {KIND_LABEL[k]}
                      </Badge>
                    ))}
                  </div>
                  <div className="text-xl font-semibold">{eur(o.total)}</div>
                  <ul className="flex flex-col gap-0.5">
                    {o.lines.map((l) => (
                      <li key={l.productId}>
                        {l.quantity} {l.salesUnit} × {l.name}
                        {l.substituteFor && <span className="text-muted-foreground"> (replaces {l.substituteFor})</span>}
                      </li>
                    ))}
                  </ul>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                    <dt>Delivered in full</dt>
                    <dd>{o.reliability === null ? 'no record' : `${Math.round(o.reliability * 100)}% of the time`}</dd>
                    <dt>CO2</dt>
                    <dd>{o.co2PerKg === null ? 'no record' : `${o.co2PerKg} kg CO2-eq per kg (group average)`}</dd>
                    <dt>Stock</dt>
                    <dd>{o.logisticModels.map((m) => (m === 'Stock' ? 'confirmed' : 'supplier, unconfirmed')).join(', ') || '–'}</dd>
                    {o.labels.length > 0 && (
                      <>
                        <dt>Labels</dt>
                        <dd>{o.labels.slice(0, 3).map((l) => l.replaceAll('_', ' ').toLowerCase()).join(', ')}</dd>
                      </>
                    )}
                  </dl>
                  {o.isSubstitute && <p className="text-xs text-destructive">A substitute: the mandate sends this order to a human.</p>}
                  {o.lines.map((l) => (
                    <VerifyCheck key={l.productId} productId={l.productId} name={l.name} />
                  ))}
                  <Button
                    variant={selected ? 'default' : 'outline'}
                    size="sm"
                    className="mt-auto self-start"
                    disabled={busy !== null || selected}
                    onClick={() => chooseOffer(o)}
                  >
                    {selected ? 'Selected' : busy === `offer-${o.id}` ? 'Pricing…' : 'Choose this offer'}
                  </Button>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {result && (
        <Step n={3} title="Order" description="A fixed-price offer held for a limited time. Ordering commits to it.">
          {quote ? (
            <div className="flex flex-col gap-3 text-sm">
              {quote.lines.map((l) => (
                <div key={l.productId}>
                  {l.quantity} {l.salesUnit} × {l.name} at {eur(l.unitPrice)} = <strong>{eur(l.lineTotal)}</strong>
                </div>
              ))}
              <div className="text-muted-foreground">
                Total {eur(quote.total)} ex VAT ({eur(quote.totalWithTax)} incl. VAT) · delivery {quote.deliveryDate} · price held
                until {clock(quote.expiresAt)}
              </div>
              <div className="text-xs text-muted-foreground">
                Signed by Valio ({quote.signature?.alg ?? 'unsigned'}).{' '}
                <a className="underline" href={`/exposure?quote=${quote.id}`} target="_blank" rel="noreferrer">
                  See what Valio withholds from the agent
                </a>
              </div>
              {!order && (
                <Button onClick={placeOrder} disabled={busy !== null} className="self-start">
                  {busy === 'order' ? 'Placing…' : 'Place order'}
                </Button>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No shortlisted product can deliver the request as asked.</p>
          )}
        </Step>
      )}

      {order && (
        <Step n={4} title="Approval" description="The mandate decides; anything outside it waits for a human.">
          <div className="flex flex-col gap-3 text-sm">
            <Badge variant={STATUS_STYLE[order.status].variant} className="h-6 px-3 text-sm">
              {STATUS_STYLE[order.status].label}
            </Badge>
            {order.policyReasons.length > 0 ? (
              <ul className="list-disc pl-5">
                {order.policyReasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground">Within the mandate: no human needed.</p>
            )}
            {order.decidedBy && (
              <p className="text-muted-foreground">
                Decided by {order.decidedBy} at {clock(order.decidedAt!)}
              </p>
            )}
            {order.status === 'pending_approval' && (
              <div className="flex flex-wrap items-center gap-2">
                <Input className="w-56" value={approver} onChange={(e) => setApprover(e.target.value)} aria-label="Approver name" />
                <Button onClick={() => decide('approve')} disabled={busy !== null || !approver.trim()}>
                  Approve
                </Button>
                <Button variant="destructive" onClick={() => decide('decline')} disabled={busy !== null || !approver.trim()}>
                  Decline
                </Button>
                <span className="text-xs text-muted-foreground">Or decide it from the Approvals page.</span>
              </div>
            )}
          </div>
        </Step>
      )}

      {audit.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Decision record</CardTitle>
            <CardDescription>What happened and why, newest first. Visible to both the buyer and Valio Aimo.</CardDescription>
          </CardHeader>
          <CardContent>
            <ol className="flex flex-col gap-2 text-sm">
              {audit.slice(0, 12).map((e) => (
                <li key={e.id} className="flex gap-3">
                  <span className="w-12 shrink-0 font-mono text-xs text-muted-foreground">{clock(e.at)}</span>
                  <Badge variant="outline" className="w-16 shrink-0">
                    {e.actor}
                  </Badge>
                  <span>{e.summary}</span>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
