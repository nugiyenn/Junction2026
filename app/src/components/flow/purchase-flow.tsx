'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { cn } from 'cn';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Page, Panel, Pill } from '@/components/page';
import type {
  AuditEvent,
  ExposedOrder,
  ExposedQuote,
  Mandate,
  Offer,
  OfferKind,
  Order,
  PolicyDecision,
  RequestResult,
} from '@/types';
import { ReceiptLink } from '@/components/verify/receipt-link';
import { signedDecision } from '@/components/verify/device-key';
import { call, clock, eur } from './api';
import { MandatePanel } from './mandate-panel';
import { LiveChecksSummary, VerifyCheck } from './verify-check';

const SCENARIOS = [
  {
    label: 'Hotel · 1,000 L lactose-free milk',
    mandateId: 'demo-hotel',
    text: 'I need 1,000 litres of lactose-free milk by Monday. Find an option that meets our requirements based on price and availability.',
  },
  { label: 'Hotel · 100 L top-up', mandateId: 'demo-hotel', text: 'I need 100 litres of lactose-free milk by Monday.' },
  { label: 'School · 20 kg granola, no nuts', mandateId: 'demo-school', text: 'I need 20 kg of granola by Tuesday.' },
  { label: 'School · 100 kg granola (short stock)', mandateId: 'demo-school', text: 'I need 100 kg of granola by Tuesday.' },
];

const KIND_LABEL: Record<OfferKind, string> = {
  cheapest: 'Cheapest',
  most_reliable: 'Most reliable',
  lowest_co2: 'Lowest CO₂',
  split: 'Split across products',
  substitute: 'Substitute',
};

const STEPS = ['Request', 'Lookup', 'Offers', 'Quote', 'Order'];

const ORDER_STATUS: Record<Order['status'], { label: string; tone: 'ok' | 'warn' | 'bad' }> = {
  confirmed: { label: 'Order confirmed', tone: 'ok' },
  pending_approval: { label: 'Waiting for approval', tone: 'warn' },
  rejected: { label: 'Order rejected', tone: 'bad' },
};

const OUTCOME = {
  auto_approve: { label: 'Auto-approved', tone: 'ok' },
  needs_approval: { label: 'Needs approval', tone: 'warn' },
  reject: { label: 'Rejected', tone: 'bad' },
} as const;

const money0 = (n: number) => `€${n.toLocaleString('en-GB', { maximumFractionDigits: 0 })}`;

function Stepper({ done }: { done: number }) {
  return (
    <Panel className="px-5 py-4" aria-label="Progress">
      <ol className="flex flex-wrap gap-x-7 gap-y-3">
        {STEPS.map((label, i) => {
          const isDone = i < done;
          const isNow = i === done;
          return (
            <li key={label} className={cn('flex items-center gap-2.5 text-sm font-medium', isNow ? 'text-foreground' : 'text-muted-foreground')}>
              <span
                className={cn(
                  'flex size-[26px] shrink-0 items-center justify-center rounded-full border-[1.5px] text-xs font-semibold',
                  isDone ? 'border-primary bg-primary text-primary-foreground' : isNow ? 'border-primary bg-card text-primary' : 'border-border bg-muted'
                )}
              >
                {isDone ? '✓' : i + 1}
              </span>
              {label}
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}

function OfferCard({
  offer,
  result,
  selected,
  busy,
  priced,
  onChoose,
}: {
  offer: Offer;
  result: RequestResult;
  selected: boolean;
  busy: boolean;
  priced: boolean;
  onChoose: () => void;
}) {
  const unit = result.interpreted.amountUnit;
  const covered = offer.lines.every((l) => l.amountCovered !== null) ? offer.lines.reduce((s, l) => s + (l.amountCovered ?? 0), 0) : null;
  const shortBy = covered !== null && unit !== 'unit' && covered < result.interpreted.amount - 1e-9 ? result.interpreted.amount - covered : null;

  return (
    <div className={cn('flex flex-col gap-3 rounded-xl border bg-card p-4', selected ? 'border-primary ring-2 ring-primary' : 'border-border')}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold">{offer.kinds.map((k) => KIND_LABEL[k]).join(' · ')}</span>
        {selected && <Pill tone="ok">Selected</Pill>}
      </div>
      <div>
        <p className="text-[1.75rem] leading-tight font-semibold tracking-tight">{eur(offer.total)}</p>
        <p className="text-xs text-muted-foreground">
          ex VAT{covered !== null && unit !== 'unit' ? ` · ${Math.round(covered * 100) / 100} ${unit}` : ''}
        </p>
      </div>
      {(offer.isSubstitute || offer.isSplit || shortBy !== null) && (
        <div className="flex flex-wrap gap-1.5">
          {offer.isSubstitute && <Pill tone="sub">Substitute</Pill>}
          {offer.isSplit && !offer.isSubstitute && <Pill>Split across {offer.lines.length} products</Pill>}
          {shortBy !== null && (
            <Pill tone="bad">
              Short by {Math.round(shortBy * 100) / 100} {unit}
            </Pill>
          )}
        </div>
      )}
      <dl className="m-0 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5 text-[13px]">
        <dt className="text-muted-foreground">Reliability</dt>
        <dd className="font-semibold">{offer.reliability === null ? 'no record' : `${Math.round(offer.reliability * 100)}%`}</dd>
        <dt className="text-muted-foreground">Carbon</dt>
        <dd className="font-semibold">{offer.co2PerKg === null ? 'no record' : `${offer.co2PerKg} kg CO₂-eq/kg`}</dd>
      </dl>
      {selected && (
        <ul className="flex flex-col gap-2 border-t pt-3 text-[13px]">
          {offer.lines.map((l) => (
            <li key={l.productId} className="flex justify-between gap-3">
              <span>
                {l.quantity} {l.salesUnit} × {l.name}
                {l.substituteFor && <span className="text-muted-foreground"> (replaces {l.substituteFor})</span>}
              </span>
              <span className="whitespace-nowrap text-muted-foreground">{eur(l.lineTotal)}</span>
            </li>
          ))}
        </ul>
      )}
      {!selected && (
        <Button variant="outline" className="mt-auto h-10 self-start" disabled={busy} onClick={onChoose}>
          {priced ? 'Pricing…' : 'Choose this offer'}
        </Button>
      )}
    </div>
  );
}

function Reason({ tone, children }: { tone: 'warn' | 'bad'; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5 text-[13px]">
      <svg
        className="mt-0.5 shrink-0"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke={tone === 'bad' ? '#9B2226' : '#7A4E00'}
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        role="img"
        aria-label={tone === 'bad' ? 'Fail' : 'Needs a person'}
      >
        {tone === 'bad' ? (
          <>
            <circle cx="12" cy="12" r="10" />
            <path d="M9 9l6 6M15 9l-6 6" />
          </>
        ) : (
          <>
            <path d="M12 3l10 18H2L12 3z" />
            <path d="M12 10v5M12 18h.01" />
          </>
        )}
      </svg>
      <span>{children}</span>
    </li>
  );
}

/** What the buyer's mandate says about the selected quote, with the limits it is measured against. */
function DecisionCard({ policy, mandate, total }: { policy: PolicyDecision; mandate: Mandate; total: number }) {
  const o = OUTCOME[policy.outcome];
  const pct = Math.min(100, (total / Math.max(mandate.maxOrderEur, 1)) * 100);
  const autoLeft = Math.max(8, Math.min(70, (mandate.autoApproveLimitEur / Math.max(mandate.maxOrderEur, 1)) * 100));
  const barColor = policy.outcome === 'auto_approve' ? 'bg-ok' : policy.outcome === 'needs_approval' ? 'bg-[#b7791f]' : 'bg-destructive';
  return (
    <Panel className="flex flex-col gap-4" aria-label="Decision">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[15px] font-semibold">Mandate decision</h2>
        <Pill tone={o.tone} large>
          {o.label}
        </Pill>
      </div>
      <div className="flex flex-col gap-2">
        <div className="relative h-2.5 overflow-hidden rounded-[5px] border bg-muted">
          <div className={cn('absolute inset-y-0 left-0 rounded-[5px]', barColor)} style={{ width: `${pct}%` }} />
        </div>
        <div className="relative h-4 text-[11px] text-muted-foreground">
          <span className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${autoLeft}%` }}>
            auto {money0(mandate.autoApproveLimitEur)}
          </span>
          <span className="absolute right-0 whitespace-nowrap">reject above {money0(mandate.maxOrderEur)}</span>
        </div>
      </div>
      {policy.reasons.length > 0 && (
        <ul className="flex flex-col gap-2.5 border-t pt-4">
          {policy.reasons.map((r) => (
            <Reason key={r} tone={policy.outcome === 'reject' ? 'bad' : 'warn'}>
              {r}
            </Reason>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export function PurchaseFlow() {
  const [mandates, setMandates] = useState<Mandate[]>([]);
  const [mandateId, setMandateId] = useState(SCENARIOS[0].mandateId);
  const [text, setText] = useState(SCENARIOS[0].text);
  const [activeScenario, setActiveScenario] = useState<string | null>(SCENARIOS[0].label);
  const [result, setResult] = useState<RequestResult | null>(null);
  const [policy, setPolicy] = useState<PolicyDecision | null>(null);
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
      setPolicy(null);
      const fresh = await call<RequestResult>('/api/requests', { mandateId: forMandate, text: forText });
      setResult(fresh);
      setPolicy(fresh.policy);
      setSelectedOfferId(fresh.offers[0]?.id ?? null);
    });

  function runScenario(s: (typeof SCENARIOS)[number]) {
    setMandateId(s.mandateId);
    setText(s.text);
    setActiveScenario(s.label);
    void submitRequest(s.mandateId, s.text);
  }

  const chooseOffer = (offer: Offer) =>
    run(`offer-${offer.id}`, async () => {
      const { quote, policy: judged } = await call<{ quote: ExposedQuote; policy: PolicyDecision }>('/api/quotes', {
        mandateId,
        deliveryDate: result!.interpreted.deliveryDate,
        lines: offer.lines.map((l) => ({ productId: l.productId, quantity: l.quantity, substituteFor: l.substituteFor })),
      });
      setResult((r) => (r ? { ...r, quote } : r));
      setPolicy(judged);
      setSelectedOfferId(offer.id);
    });

  const placeOrder = () =>
    run('order', async () => {
      setOrder((await call<{ order: ExposedOrder }>('/api/orders', { quoteId: result!.quote!.id })).order);
    });

  const decide = (decision: 'approve' | 'decline') =>
    run(decision, async () => {
      const body = { decision, decidedBy: approver, ...(await signedDecision(order!.id, decision, approver)) };
      setOrder((await call<{ order: ExposedOrder }>(`/api/orders/${order!.id}/decision`, body)).order);
    });

  async function resetDemo() {
    if (!window.confirm('Delete all quotes, orders and the decision record? Mandates and the catalog are kept.')) return;
    await run('reset', async () => {
      await call('/api/demo/reset', {});
      setResult(null);
      setOrder(null);
      setPolicy(null);
    });
  }

  const quote = result?.quote ?? null;
  const selectedOffer = result?.offers.find((o) => o.id === selectedOfferId) ?? null;
  const done = !result ? 0 : order ? 5 : quote ? 4 : 3;
  const anyBusy = busy !== null;

  return (
    <Page
      title="Buyer agent"
      actions={
        <Button variant="ghost" className="h-10" disabled={anyBusy} onClick={resetDemo}>
          Reset demo data
        </Button>
      }
    >
      <section aria-label="Scenarios" className="flex flex-wrap items-center gap-2">
        <span className="mr-1 text-xs font-medium text-muted-foreground">Scenario</span>
        {SCENARIOS.map((s) => (
          <Button
            key={s.label}
            variant={activeScenario === s.label ? 'default' : 'outline'}
            className={cn('h-11 rounded-full px-4', activeScenario === s.label && 'bg-foreground text-background hover:bg-foreground/90')}
            disabled={anyBusy}
            onClick={() => runScenario(s)}
          >
            {s.label}
          </Button>
        ))}
      </section>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Request failed</AlertTitle>
          <AlertDescription className="break-words">{error}</AlertDescription>
        </Alert>
      )}

      <Stepper done={done} />

      <Panel className="flex flex-col gap-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[17px] font-semibold">Request</h2>
          <select
            aria-label="Mandate"
            className="h-9 rounded-lg border border-input bg-card px-2.5 text-sm"
            value={mandateId}
            onChange={(e) => {
              setMandateId(e.target.value);
              setActiveScenario(null);
            }}
          >
            {mandates.map((m) => (
              <option key={m.id} value={m.id}>
                Mandate: {m.buyerName}
              </option>
            ))}
          </select>
        </div>
        <textarea
          aria-label="Request"
          className="min-h-[72px] w-full rounded-[10px] border border-input bg-card px-3 py-2.5 text-sm leading-relaxed"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setActiveScenario(null);
          }}
        />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Button onClick={() => submitRequest()} disabled={anyBusy || text.trim().length < 3} className="h-11 px-5">
            {busy === 'request' ? 'Interpreting and pricing…' : 'Send request'}
          </Button>
          {result && (
            <>
              <Pill className="h-7 border border-border bg-muted px-3 text-[13px] font-medium text-foreground">{result.interpreted.product}</Pill>
              <Pill className="h-7 border border-border bg-muted px-3 text-[13px] font-medium text-foreground">
                {result.interpreted.amount} {result.interpreted.amountUnit}
              </Pill>
              <Pill className="h-7 border border-border bg-muted px-3 text-[13px] font-medium text-foreground">by {result.interpreted.deliveryDate}</Pill>
              {result.interpreted.requiredClaims.map((c) => (
                <Pill key={c} tone="ok">
                  {c.replaceAll('_', ' ').toLowerCase()}
                </Pill>
              ))}
            </>
          )}
        </div>
        {result && (
          <details className="text-xs text-muted-foreground">
            <summary className="flex min-h-9 cursor-pointer flex-wrap items-center gap-2 py-1">
              <span>Interpretation</span>
              {result.interpretationCheck?.status === 'agree' && <Pill tone="ok">Second opinion agrees</Pill>}
              {result.interpretationCheck?.status === 'disagree' && <Pill tone="bad">Second opinion disagrees</Pill>}
              {result.interpretationCheck?.status === 'unavailable' && <Pill>Second opinion n/a</Pill>}
              {result.excludedByMandate > 0 && <Pill tone="warn">{result.excludedByMandate} excluded: allergens</Pill>}
            </summary>
            <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 pt-1">
              <dt>Read by</dt>
              <dd>{result.models.interpreted}</dd>
              <dt>Matches by</dt>
              <dd>{result.models.picked}</dd>
              {result.interpretationCheck && (
                <>
                  <dt>Second opinion</dt>
                  <dd>
                    {result.interpretationCheck.secondModel}
                    {result.interpretationCheck.status === 'agree' && ` · ${result.interpretationCheck.detail}`}
                    {result.interpretationCheck.status === 'disagree' && ` · ${result.interpretationCheck.differences.join(' · ')}`}
                  </dd>
                </>
              )}
            </dl>
          </details>
        )}
      </Panel>

      {result?.interpretationCheck?.status === 'disagree' && (
        <Alert variant="destructive">
          <AlertTitle>Models read the request differently</AlertTitle>
          <AlertDescription>{result.interpretationCheck.differences.join('; ')}</AlertDescription>
        </Alert>
      )}

      {mandate && (
        <details className="group rounded-xl border bg-card">
          <summary className="flex min-h-12 cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 text-sm">
            <span className="font-semibold">Mandate</span>
            <span className="text-muted-foreground">
              auto up to {money0(mandate.autoApproveLimitEur)} · reject above {money0(mandate.maxOrderEur)}
              {mandate.minDeliveryReliability !== null && ` · reliability ≥ ${Math.round(mandate.minDeliveryReliability * 100)}%`}
              {mandate.maxCo2PerKg !== null && ` · carbon ≤ ${mandate.maxCo2PerKg}`}
              {mandate.blockedAllergens.length > 0 && ` · blocks ${mandate.blockedAllergens.join(', ')}`}
            </span>
            <span className="ml-auto text-xs text-primary group-open:hidden">Edit</span>
          </summary>
          <div className="border-t px-5 py-4">
            <MandatePanel
              key={`${mandate.id}-${JSON.stringify(mandate)}`}
              mandate={mandate}
              onSaved={(saved) => {
                setMandates((all) => all.map((m) => (m.id === saved.id ? saved : m)));
                void run('audit', async () => undefined);
              }}
              onError={setError}
            />
          </div>
        </details>
      )}

      {result && result.offers.length === 0 && (
        <Alert>
          <AlertTitle>No offer possible</AlertTitle>
          <AlertDescription>{result.notes.join(' ') || 'No shortlisted product can deliver this request.'}</AlertDescription>
        </Alert>
      )}

      {result && result.offers.length > 0 && (
        <div className="flex flex-wrap items-start gap-6">
          <div className="flex min-w-0 flex-[999_1_620px] flex-col gap-6">
            <section aria-label="Offers" className="flex flex-col gap-3">
              <h2 className="text-[17px] font-semibold">Offers</h2>
              <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-3.5">
                {result.offers.map((o) => (
                  <OfferCard
                    key={o.id}
                    offer={o}
                    result={result}
                    selected={o.id === selectedOfferId}
                    busy={anyBusy}
                    priced={busy === `offer-${o.id}`}
                    onChoose={() => chooseOffer(o)}
                  />
                ))}
              </div>
              {result.notes.length > 0 && (
                <details className="text-xs text-muted-foreground">
                  <summary className="min-h-9 cursor-pointer py-1.5">Notes ({result.notes.length})</summary>
                  <ul className="flex flex-col gap-1 pt-1">
                    {result.notes.map((n) => (
                      <li key={n}>{n}</li>
                    ))}
                  </ul>
                </details>
              )}
            </section>

            {selectedOffer && (
              <Panel className="flex flex-col gap-3" aria-label="Web check">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="text-[17px] font-semibold">Web check</h2>
                  <span className="text-xs text-muted-foreground">Optional · up to 2 min</span>
                </div>
                {selectedOffer.lines.map((l) => (
                  <VerifyCheck key={l.productId} productId={l.productId} name={l.name} />
                ))}
              </Panel>
            )}

            <details className="rounded-xl border bg-card">
              <summary className="min-h-12 cursor-pointer px-5 py-3 text-sm font-medium">Candidates ({result.candidates.length})</summary>
              <div className="overflow-x-auto border-t px-2 py-2">
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
                        <TableCell>{c.logisticModel === 'Stock' ? 'Confirmed' : c.logisticModel === 'Terminal' ? 'Unconfirmed' : '–'}</TableCell>
                        <TableCell className="max-w-64 whitespace-normal text-xs">{c.reasons.join(' ')}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </details>
          </div>

          <aside className="flex min-w-0 flex-[1_1_340px] flex-col gap-6">
            {policy && mandate && quote && <DecisionCard policy={policy} mandate={mandate} total={quote.total} />}
            {result.liveChecks && <LiveChecksSummary checks={result.liveChecks} />}

            {quote && (
              <Panel className="flex flex-col gap-4" aria-label="Quote">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-[17px] font-semibold">Signed quote</h2>
                  <Pill>Valid until {clock(quote.expiresAt)}</Pill>
                </div>
                <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[13px]">
                  <dt className="text-muted-foreground">Total ex VAT</dt>
                  <dd className="text-right font-semibold">{eur(quote.total)}</dd>
                  <dt className="text-muted-foreground">Delivery</dt>
                  <dd className="text-right">{quote.deliveryDate}</dd>
                  <dt className="text-muted-foreground">Signature</dt>
                  <dd className="text-right">{quote.signature ? 'Signed' : 'Unsigned'}</dd>
                </dl>
                <Link href={`/exposure?quote=${quote.id}`} target="_blank" className="text-[13px] text-primary underline">
                  Agent view ↗
                </Link>

                {!order && (
                  <Button onClick={placeOrder} disabled={anyBusy || policy?.outcome === 'reject'} className="h-11">
                    {busy === 'order' ? 'Placing…' : policy?.outcome === 'needs_approval' ? 'Place order for approval' : 'Place order'}
                  </Button>
                )}
                {!order && policy?.outcome === 'reject' && <p className="text-xs text-muted-foreground">Blocked by the mandate.</p>}

                {order && (
                  <div
                    className={cn(
                      'flex flex-col gap-2 rounded-lg p-3.5',
                      ORDER_STATUS[order.status].tone === 'ok' && 'bg-ok-soft text-ok',
                      ORDER_STATUS[order.status].tone === 'warn' && 'bg-warn-soft text-warn',
                      ORDER_STATUS[order.status].tone === 'bad' && 'bg-bad-soft text-destructive'
                    )}
                  >
                    <p className="font-semibold">
                      {order.status === 'rejected' && order.decidedBy ? 'Order declined' : ORDER_STATUS[order.status].label}
                    </p>
                    {order.decidedBy && (
                      <p className="text-[13px]">
                        {order.status === 'confirmed' ? 'Approved' : 'Declined'} by {order.decidedBy} at {clock(order.decidedAt!)}
                      </p>
                    )}
                    {order.status !== 'pending_approval' && <ReceiptLink id={order.id} />}
                    {order.status === 'pending_approval' && (
                      <div className="flex flex-wrap items-center gap-2 pt-1">
                        <Input className="h-10 w-44 bg-card" value={approver} onChange={(e) => setApprover(e.target.value)} aria-label="Approver name" />
                        <Button className="h-10" onClick={() => decide('approve')} disabled={anyBusy || !approver.trim()}>
                          Approve
                        </Button>
                        <Button variant="outline" className="h-10 bg-card text-destructive" onClick={() => decide('decline')} disabled={anyBusy || !approver.trim()}>
                          Decline
                        </Button>
                        <Link href="/approvals" className="w-full text-xs underline">
                          Open Approvals
                        </Link>
                      </div>
                    )}
                  </div>
                )}
              </Panel>
            )}

            {audit.length > 0 && (
              <Panel className="flex flex-col gap-3.5" aria-label="Decision record">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-[17px] font-semibold">Decision record</h2>
                  <Link href="/audit" className="text-[13px] text-primary underline">
                    Open
                  </Link>
                </div>
                <ol className="flex flex-col gap-3.5">
                  {audit.slice(0, 2).map((e) => (
                    <li key={e.id} className="flex flex-col gap-0.5">
                      <p className="line-clamp-2 text-[13px]" title={e.summary}>{e.summary}</p>
                      <p className="text-xs text-muted-foreground">
                        {clock(e.at)} · {e.actor}
                      </p>
                    </li>
                  ))}
                </ol>
              </Panel>
            )}
          </aside>
        </div>
      )}
    </Page>
  );
}
