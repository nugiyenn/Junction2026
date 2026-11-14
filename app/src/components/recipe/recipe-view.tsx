'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { cn } from 'cn';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { call, clock, eur } from '@/components/flow/api';
import { Page, Panel, Pill, type Tone } from '@/components/page';
import { ReceiptLink } from '@/components/verify/receipt-link';
import type { ExposedOrder, ExposedQuote, Mandate, PolicyDecision, RecipeLineMatch, RecipeMatchStatus, RecipeProduct, RecipeResult, RecipeUnit } from '@/types';

const EXAMPLES = [
  { label: 'Pizzeria list', text: '20 kg mozzarella, 10 kg tomato sauce, 2 kg parmesan, 1 kg basil, 5 kg onion, 10 kg flour' },
  {
    label: '15-line recipe',
    text: `0,323 kg
[Oddlygood® Cooking Oat tuotetta](https://www.valioaimo.fi/ammattilaistuotteet/oddlygood-cooking-oat-original/1-l-tolkki/)
0,277 kg Oddlygood® Dream Fraiche tuotetta
1,062 kg kylmää vettä
0,037 kg punaviinietikkaa
0,016 kg valkosipulimurskaa
0,139 kg tomaattipyreetä
0,021 kg kasvisliemijauhetta
0,002 kg suolaa
0,001 kg jauhettua mustapippuria
0,003 kg kuivattua rakuunaa
0,009 kg sokeria
0,021 kg kylmätärkkelystä
0,877 kg
[Valio Gold&Green® suikaleita original](https://www.valioaimo.fi/ammattilaistuotteet/valio-goldgreen-suikale-original/)
0,277 kg fenkolia
0,111 kg pakastesipulikuutioita`,
  },
];

const STATUS: Record<RecipeMatchStatus | 'cannot' | 'alternative' | 'not_ordered', { label: string; tone: Tone }> = {
  matched: { label: 'Matched', tone: 'ok' },
  weak: { label: 'Check this', tone: 'warn' },
  not_found: { label: "Not in Valio's range", tone: 'plain' },
  // Water and ice: neutral, not a miss.
  not_ordered: { label: 'Not ordered', tone: 'plain' },
  unpriced: { label: 'No price', tone: 'warn' },
  // The product fits, but Valio cannot deliver it as asked: never shown as "Matched".
  cannot: { label: "Can't order", tone: 'bad' },
  alternative: { label: 'Alternative', tone: 'sub' },
};

const OUTCOME = {
  auto_approve: { label: 'Auto-approved', tone: 'ok' },
  needs_approval: { label: 'Needs approval', tone: 'warn' },
  reject: { label: 'Rejected', tone: 'bad' },
} as const;

const ORDER_STATUS: Record<ExposedOrder['status'], { label: string; tone: 'ok' | 'warn' | 'bad' }> = {
  confirmed: { label: 'Order confirmed', tone: 'ok' },
  pending_approval: { label: 'Waiting for approval', tone: 'warn' },
  rejected: { label: 'Order rejected', tone: 'bad' },
};

const UNIT_LABEL: Record<RecipeUnit, string> = { KG: 'kg', L: 'l', unit: 'pcs' };
const num = (n: number) => n.toLocaleString('en-GB', { maximumFractionDigits: 4 });
const money0 = (n: number) => `€${n.toLocaleString('en-GB', { maximumFractionDigits: 0 })}`;

/** What can be put in a quote: a pack count, a price, and a product Valio can deliver. */
const orderable = (p: RecipeProduct | undefined | null): p is RecipeProduct => Boolean(p && p.quantity !== null && p.unitPrice !== null && p.fulfillable);

interface Pick {
  on: boolean;
  /** 0 is the proposal, 1 and 2 the alternatives. */
  choice: number;
}

const options = (line: RecipeLineMatch): RecipeProduct[] => (line.proposal ? [line.proposal, ...line.alternatives] : []);

/** Matched lines Valio can deliver start ticked. Lines to check, and lines a model read out of prose, start unticked: the buyer decides. */
const initialPicks = (lines: RecipeLineMatch[]): Pick[] =>
  lines.map((l) => ({ on: l.readBy === 'code' && l.status === 'matched' && orderable(l.proposal), choice: 0 }));

/** The packs ("2 packs") and what is in each ("of 0.4 kg"). */
function packText(p: RecipeProduct): { packs: string; size: string | null } | null {
  if (p.quantity === null) return null;
  if (p.packUnit === 'unit') return { packs: `${num(p.quantity)} pcs`, size: null };
  return {
    packs: `${num(p.quantity)} ${p.quantity === 1 ? 'pack' : 'packs'}`,
    size: p.packSize !== null && p.packUnit ? `of ${num(p.packSize)} ${UNIT_LABEL[p.packUnit]}` : null,
  };
}

function ProductChoice({ line, pick, disabled, onChange }: { line: RecipeLineMatch; pick: Pick; disabled: boolean; onChange: (choice: number) => void }) {
  const list = options(line);
  if (list.length === 0) return <span className="text-muted-foreground">No product proposed</span>;
  const label = (p: RecipeProduct) => `${p.name}${p.unitPrice !== null ? ` · ${eur(p.unitPrice)}` : ''}${orderable(p) ? '' : " (can't order)"}`;
  return (
    <div className="flex flex-col gap-1">
      {list.length > 1 ? (
        <select
          aria-label={`Product for ${line.name}`}
          className="h-10 w-full min-w-0 rounded-lg border border-input bg-card px-2 text-sm"
          value={pick.choice}
          disabled={disabled}
          onChange={(e) => onChange(Number(e.target.value))}
        >
          {list.map((p, i) => (
            <option key={p.productId} value={i}>
              {i === 0 ? 'Proposed: ' : 'Instead: '}
              {label(p)}
            </option>
          ))}
        </select>
      ) : (
        <span className="text-sm font-medium">{label(list[0])}</span>
      )}
      {list[pick.choice]?.brand && <span className="text-xs text-muted-foreground">{list[pick.choice].brand}</span>}
    </div>
  );
}

/** The same test without narrowing the type, for the branch where the product turns out not to be orderable. */
const canOrder = (p: RecipeProduct): boolean => orderable(p);

/** What the badge says: the match, unless the chosen product cannot be ordered, which then comes first. */
function badgeFor(line: RecipeLineMatch, chosen: RecipeProduct | undefined, choice: number): keyof typeof STATUS {
  if (line.notOrdered) return 'not_ordered';
  if (line.status === 'not_found' || !chosen) return 'not_found';
  if (!canOrder(chosen)) return chosen.quantity === null ? 'unpriced' : 'cannot';
  return choice > 0 ? 'alternative' : line.status === 'unpriced' ? 'matched' : line.status;
}

/** Why the chosen product cannot be ordered, in plain words (the issue texts never name exact stock). */
const reasonFor = (chosen: RecipeProduct | undefined): string | null =>
  chosen && !canOrder(chosen) ? (chosen.issues.join(' ') || 'This product cannot be ordered at the moment.') : null;

/** What the matcher says about the proposed product (not shown for a product the buyer picked instead). */
const matchNote = (line: RecipeLineMatch, choice: number): string | null => (choice === 0 ? line.note : null);

export function RecipeView() {
  const [mandates, setMandates] = useState<Mandate[]>([]);
  const [mandateId, setMandateId] = useState('demo-hotel');
  const [text, setText] = useState(EXAMPLES[0].text);
  const [factor, setFactor] = useState('1');
  const [date, setDate] = useState('');
  const [result, setResult] = useState<RecipeResult | null>(null);
  const [picks, setPicks] = useState<Pick[]>([]);
  const [quote, setQuote] = useState<ExposedQuote | null>(null);
  const [policy, setPolicy] = useState<PolicyDecision | null>(null);
  const [order, setOrder] = useState<ExposedOrder | null>(null);
  const [busy, setBusy] = useState<'match' | 'quote' | 'order' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    call<{ mandates: Mandate[] }>('/api/mandates')
      .then((r) => setMandates(r.mandates))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const mandate = mandates.find((m) => m.id === mandateId) ?? null;
  const factorNumber = Number(factor.replace(',', '.'));
  const factorOk = factor.trim() !== '' && Number.isFinite(factorNumber) && factorNumber >= 0.01 && factorNumber <= 1000;

  /** The ticked lines as quote lines. Two lines that use the same product become one quote line (a quote allows each product once). */
  const selection = useMemo(() => {
    const byProduct = new Map<string, { productId: string; quantity: number; total: number; lines: number[] }>();
    result?.lines.forEach((line, i) => {
      const chosen = options(line)[picks[i]?.choice ?? 0];
      if (!picks[i]?.on || !orderable(chosen)) return;
      const entry = byProduct.get(chosen.productId) ?? { productId: chosen.productId, quantity: 0, total: 0, lines: [] };
      entry.quantity += chosen.quantity!;
      entry.total += chosen.unitPrice! * chosen.quantity!;
      entry.lines.push(i);
      byProduct.set(chosen.productId, entry);
    });
    const list = [...byProduct.values()];
    return { list, count: list.reduce((n, e) => n + e.lines.length, 0), total: list.reduce((s, e) => s + e.total, 0), merged: list.filter((e) => e.lines.length > 1) };
  }, [result, picks]);

  const locked = order !== null;
  const change = (fn: () => void) => {
    fn();
    setQuote(null);
    setPolicy(null);
  };

  async function matchProducts() {
    setBusy('match');
    setError(null);
    setResult(null);
    setQuote(null);
    setPolicy(null);
    setOrder(null);
    try {
      const fresh = await call<RecipeResult>('/api/recipe', { mandateId, text, multiplier: factorNumber, ...(date ? { deliveryDate: date } : {}) });
      setResult(fresh);
      setPicks(initialPicks(fresh.lines));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function createQuote() {
    if (!result) return;
    setBusy('quote');
    setError(null);
    try {
      const made = await call<{ quote: ExposedQuote; policy: PolicyDecision }>('/api/quotes', {
        mandateId,
        deliveryDate: result.deliveryDate,
        lines: selection.list.map((e) => ({ productId: e.productId, quantity: e.quantity })),
      });
      setQuote(made.quote);
      setPolicy(made.policy);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function placeOrder() {
    if (!quote) return;
    setBusy('order');
    setError(null);
    try {
      setOrder((await call<{ order: ExposedOrder }>('/api/orders', { quoteId: quote.id })).order);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const anyBusy = busy !== null;
  const overAuto = mandate !== null && selection.total > mandate.autoApproveLimitEur;
  const overMax = mandate !== null && selection.total > mandate.maxOrderEur;

  return (
    <Page title="Recipe order">
      <p className="max-w-3xl text-sm text-muted-foreground">
        Paste a recipe or a shopping list. Each line is matched to a Valio product, the packs are worked out from Valio&apos;s price, and the lines you keep
        become one quote. Nothing is ordered until you place the order.
      </p>
      <p className="max-w-3xl text-sm text-muted-foreground">
        Some products cannot be ordered at the moment (past cut-off or no delivery); they are shown but left out of the order.
      </p>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription className="break-words">{error}</AlertDescription>
        </Alert>
      )}

      <Panel className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[17px] font-semibold">Recipe</h2>
          <select
            aria-label="Mandate"
            className="h-9 rounded-lg border border-input bg-card px-2.5 text-sm"
            value={mandateId}
            disabled={anyBusy || locked}
            onChange={(e) => setMandateId(e.target.value)}
          >
            {mandates.length === 0 && <option value={mandateId}>Mandate: {mandateId}</option>}
            {mandates.map((m) => (
              <option key={m.id} value={m.id}>
                Mandate: {m.buyerName}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 text-xs font-medium text-muted-foreground">Example</span>
          {EXAMPLES.map((e) => (
            <Button key={e.label} variant="outline" className="h-10 rounded-full px-4" disabled={anyBusy || locked} onClick={() => setText(e.text)}>
              {e.label}
            </Button>
          ))}
        </div>

        <textarea
          aria-label="Recipe text"
          className="min-h-40 w-full rounded-[10px] border border-input bg-card px-3 py-2.5 text-sm leading-relaxed"
          value={text}
          maxLength={4000}
          placeholder={'20 kg mozzarella\n10 kg tomato sauce\npizza dough 50 pcs'}
          disabled={locked}
          onChange={(e) => setText(e.target.value)}
        />

        <div className="flex flex-wrap items-start gap-x-6 gap-y-4">
          <label className="flex min-w-0 flex-col gap-1.5 text-sm font-medium">
            Portions factor
            <Input
              inputMode="decimal"
              className="h-10 w-32 bg-card"
              value={factor}
              aria-invalid={!factorOk}
              disabled={locked}
              onChange={(e) => setFactor(e.target.value)}
            />
            <span className="max-w-xs text-xs font-normal text-muted-foreground">
              Every amount in the text is multiplied by this. Leave it at 1 to order the amounts as written.
            </span>
          </label>
          <label className="flex min-w-0 flex-col gap-1.5 text-sm font-medium">
            Delivery date
            <Input type="date" className="h-10 w-44 bg-card" value={date} disabled={locked} onChange={(e) => setDate(e.target.value)} />
            <span className="max-w-xs text-xs font-normal text-muted-foreground">
              Optional. Without a date, the first weekday at least 3 days ahead, or a weekday named in the text.
            </span>
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button className="h-11 px-5" onClick={matchProducts} disabled={anyBusy || locked || text.trim().length < 3 || !factorOk}>
            {busy === 'match' ? 'Matching products…' : 'Match products'}
          </Button>
          {busy === 'match' && <span className="text-xs text-muted-foreground">This can take up to a minute.</span>}
          {!factorOk && <span className="text-xs text-destructive">The portions factor must be from 0.01 to 1000.</span>}
        </div>
      </Panel>

      {result && (
        <>
          <section aria-label="Matched lines" className="flex flex-col gap-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-[17px] font-semibold">
                {result.lines.length} line{result.lines.length === 1 ? '' : 's'} for delivery on {result.deliveryDate}
              </h2>
              <span className="text-xs text-muted-foreground">Prices ex VAT</span>
            </div>
            {result.readByModel && (
              <Alert>
                <AlertTitle>Read by a model, check each line</AlertTitle>
                <AlertDescription>
                  The text was not a list the parser could read, so a model split it into lines. Check the name and amount of every line marked
                  &quot;Read by a model&quot;, then tick the ones you want.
                </AlertDescription>
              </Alert>
            )}
            {result.notes.length > 0 && (
              <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
                {result.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            )}

            <div className="hidden rounded-xl border bg-card md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10 pl-4">
                      <span className="sr-only">Include</span>
                    </TableHead>
                    <TableHead>Line</TableHead>
                    <TableHead className="min-w-60">Product</TableHead>
                    <TableHead>Order</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="pr-4 text-right">Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.lines.map((line, i) => (
                    <LineRow key={line.index} line={line} pick={picks[i]} disabled={locked} layout="row" onChange={(p) => change(() => setPicks((all) => all.map((x, j) => (j === i ? p : x))))} />
                  ))}
                </TableBody>
              </Table>
            </div>

            <ul className="flex flex-col gap-3 md:hidden">
              {result.lines.map((line, i) => (
                <LineRow key={line.index} line={line} pick={picks[i]} disabled={locked} layout="card" onChange={(p) => change(() => setPicks((all) => all.map((x, j) => (j === i ? p : x))))} />
              ))}
            </ul>

            {result.skipped.length > 0 && (
              <Alert>
                <AlertTitle>
                  {result.skipped.length} line{result.skipped.length === 1 ? '' : 's'} could not be read
                </AlertTitle>
                <AlertDescription>
                  <p>Write each as an amount, a unit and a name, for example &quot;2 kg flour&quot;. These are left out:</p>
                  <ul className="mt-1 flex flex-col gap-0.5">
                    {result.skipped.map((s, i) => (
                      <li key={`${i}-${s}`} className="break-words">
                        &quot;{s}&quot;
                      </li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            )}
          </section>

          <Panel className="flex flex-col gap-4" aria-label="Order summary">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-[17px] font-semibold">Your order</h2>
              <p className="text-sm text-muted-foreground">
                {selection.count} of {result.lines.length} lines
              </p>
            </div>
            <div>
              <p className="text-[1.75rem] leading-tight font-semibold tracking-tight">{eur(selection.total)}</p>
              <p className="text-xs text-muted-foreground">Total ex VAT, at today&apos;s prices</p>
            </div>
            {selection.merged.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {selection.merged.length === 1 ? 'One product is' : `${selection.merged.length} products are`} used by more than one line. Each becomes a single quote
                line with the packs added together.
              </p>
            )}
            {mandate && (
              <p className={cn('text-[13px]', overMax ? 'text-destructive' : overAuto ? 'text-warn' : 'text-ok')}>
                {overMax
                  ? `Above the ${money0(mandate.maxOrderEur)} limit of this mandate: the order will be rejected. Remove lines or split the order.`
                  : overAuto
                    ? `Above the auto-approve limit of ${money0(mandate.autoApproveLimitEur)}: a person will need to approve the order.`
                    : `Within the auto-approve limit of ${money0(mandate.autoApproveLimitEur)}.`}{' '}
                <span className="text-muted-foreground">The mandate decides when you create the quote.</span>
              </p>
            )}
            {!quote && (
              <div className="flex flex-wrap items-center gap-3">
                <Button className="h-11 px-5" onClick={createQuote} disabled={anyBusy || selection.count === 0}>
                  {busy === 'quote' ? 'Creating quote…' : 'Create quote'}
                </Button>
                {selection.count === 0 && <span className="text-xs text-muted-foreground">Tick at least one line.</span>}
              </div>
            )}
          </Panel>

          {quote && policy && (
            <Panel className="flex flex-col gap-4" aria-label="Quote">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-[17px] font-semibold">Quote</h2>
                <Pill>Valid until {clock(quote.expiresAt)}</Pill>
              </div>
              <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[13px]">
                <dt className="text-muted-foreground">Lines</dt>
                <dd className="text-right">{quote.lines.length}</dd>
                <dt className="text-muted-foreground">Total ex VAT</dt>
                <dd className="text-right font-semibold">{eur(quote.total)}</dd>
                <dt className="text-muted-foreground">Delivery</dt>
                <dd className="text-right">{quote.deliveryDate}</dd>
                <dt className="text-muted-foreground">Signature</dt>
                <dd className="text-right">{quote.signature ? 'Signed' : 'Unsigned'}</dd>
              </dl>
              <div className="flex flex-col gap-2.5 border-t pt-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-[15px] font-semibold">Mandate decision</h3>
                  <Pill tone={OUTCOME[policy.outcome].tone} large>
                    {OUTCOME[policy.outcome].label}
                  </Pill>
                </div>
                {policy.reasons.length > 0 && (
                  <ul className="flex flex-col gap-1.5 text-[13px]">
                    {policy.reasons.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                )}
              </div>
              <details className="text-[13px]">
                <summary className="min-h-9 cursor-pointer py-1.5 text-muted-foreground">Quote lines ({quote.lines.length})</summary>
                <ul className="flex flex-col gap-1.5 pt-1">
                  {quote.lines.map((l) => (
                    <li key={l.productId} className="flex justify-between gap-3">
                      <span className="min-w-0 break-words">
                        {l.quantity} × {l.name}
                      </span>
                      <span className="whitespace-nowrap text-muted-foreground">{eur(l.lineTotal)}</span>
                    </li>
                  ))}
                </ul>
              </details>

              {!order && (
                <div className="flex flex-wrap items-center gap-3">
                  <Button className="h-11 px-5" onClick={placeOrder} disabled={anyBusy || policy.outcome === 'reject'}>
                    {busy === 'order' ? 'Placing…' : policy.outcome === 'needs_approval' ? 'Place order for approval' : 'Place order'}
                  </Button>
                  {policy.outcome === 'reject' && <span className="text-xs text-muted-foreground">Blocked by the mandate. Change the lines and create a new quote.</span>}
                </div>
              )}

              {order && (
                <div
                  className={cn(
                    'flex flex-col gap-2 rounded-lg p-3.5',
                    ORDER_STATUS[order.status].tone === 'ok' && 'bg-ok-soft text-ok',
                    ORDER_STATUS[order.status].tone === 'warn' && 'bg-warn-soft text-warn',
                    ORDER_STATUS[order.status].tone === 'bad' && 'bg-bad-soft text-destructive'
                  )}
                >
                  <p className="font-semibold">{ORDER_STATUS[order.status].label}</p>
                  <p className="text-[13px]">
                    {eur(order.total)} ex VAT · {order.lines.length} lines
                  </p>
                  {order.status === 'pending_approval' && (
                    <Link href="/approvals" className="text-[13px] underline">
                      A person approves it in Approvals
                    </Link>
                  )}
                  {order.status === 'rejected' && order.policyReasons.length > 0 && <p className="text-[13px]">{order.policyReasons.join(' ')}</p>}
                  {order.status !== 'pending_approval' && <ReceiptLink id={order.id} />}
                </div>
              )}
            </Panel>
          )}
        </>
      )}
    </Page>
  );
}

function LineRow({
  line,
  pick,
  disabled,
  layout,
  onChange,
}: {
  line: RecipeLineMatch;
  pick: Pick | undefined;
  disabled: boolean;
  layout: 'row' | 'card';
  onChange: (pick: Pick) => void;
}) {
  const p = pick ?? { on: false, choice: 0 };
  const chosen = options(line)[p.choice];
  const canTick = orderable(chosen);
  const status = STATUS[badgeFor(line, chosen, p.choice)];
  const reason = reasonFor(chosen);
  const note = matchNote(line, p.choice);
  const total = p.on && canTick ? chosen.unitPrice! * chosen.quantity! : null;
  const checkbox = (
    <input
      type="checkbox"
      className="size-5 shrink-0 accent-primary"
      aria-label={canTick ? `Include ${line.name}` : `Cannot include ${line.name}: ${reason ?? 'no product proposed'}`}
      checked={p.on && canTick}
      disabled={disabled || !canTick}
      onChange={(e) => onChange({ ...p, on: e.target.checked })}
    />
  );
  const choose = (choice: number) => onChange({ choice, on: p.on && orderable(options(line)[choice]) });
  const amount = (
    <>
      <span className="font-medium break-words">{line.name}</span>
      <span className="block text-xs text-muted-foreground">
        {num(line.amount)} {UNIT_LABEL[line.unit]}
        {line.amount !== line.baseAmount && ` (${num(line.baseAmount)} as written)`}
      </span>
      {line.readBy === 'model' && (
        <Pill tone="sub" className="mt-1">
          Read by a model
        </Pill>
      )}
    </>
  );
  const noteList = note && <p className="mt-1 text-xs text-muted-foreground">{note}</p>;
  const reasonText = reason && <p className="mt-1 text-xs font-medium text-destructive">{reason}</p>;
  const pack = chosen ? packText(chosen) : null;
  const order = pack ? (
    <>
      <span className="whitespace-nowrap">{pack.packs}</span>
      {pack.size && <span className="block text-xs whitespace-nowrap text-muted-foreground">{pack.size}</span>}
    </>
  ) : null;

  if (layout === 'row') {
    return (
      <TableRow className={cn(!canTick && 'text-muted-foreground')}>
        <TableCell className="pl-4 align-top">{checkbox}</TableCell>
        <TableCell className="max-w-56 align-top whitespace-normal">{amount}</TableCell>
        <TableCell className="align-top whitespace-normal">
          <ProductChoice line={line} pick={p} disabled={disabled} onChange={choose} />
          {noteList}
        </TableCell>
        <TableCell className="align-top">{order ?? '–'}</TableCell>
        <TableCell className="max-w-48 align-top whitespace-normal">
          <Pill tone={status.tone}>{status.label}</Pill>
          {reasonText}
        </TableCell>
        <TableCell className="pr-4 text-right align-top">{eur(total)}</TableCell>
      </TableRow>
    );
  }
  return (
    <li className={cn('flex flex-col gap-3 rounded-xl border bg-card p-4', !canTick && 'text-muted-foreground')}>
      <div className="flex items-start gap-3">
        {checkbox}
        <div className="min-w-0 flex-1">{amount}</div>
        <Pill tone={status.tone} className="shrink-0">
          {status.label}
        </Pill>
      </div>
      <ProductChoice line={line} pick={p} disabled={disabled} onChange={choose} />
      {reasonText}
      {noteList}
      <div className="flex justify-between gap-3 border-t pt-2 text-sm">
        <span className="flex items-baseline gap-1.5">{order ?? '–'}</span>
        <span className="font-semibold">{eur(total)}</span>
      </div>
    </li>
  );
}
