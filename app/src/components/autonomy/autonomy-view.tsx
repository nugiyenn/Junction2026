'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { call, eur } from '@/components/flow/api';
import { Page, Panel, Pill } from '@/components/page';
import type { AutonomyAcceptResponse, AutonomyMonth, AutonomyResponse, AutonomySuggestion, Mandate } from '@/types';

const pct = (x: number) => `${Math.round(x * 100)} %`;
const euro0 = (n: number) => eur(n).replace(/\.00$/, '');

export function AutonomyView() {
  const [mandates, setMandates] = useState<Mandate[] | null>(null);
  const [mandateId, setMandateId] = useState<string | null>(null);
  const [data, setData] = useState<AutonomyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approver, setApprover] = useState('Purchasing manager');
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<AutonomyAcceptResponse | null>(null);

  const fail = (err: unknown) => setError(err instanceof Error ? err.message : String(err));

  useEffect(() => {
    call<{ mandates: Mandate[] }>('/api/mandates')
      .then((r) => {
        setMandates(r.mandates);
        // Start on the buyer that has something to accept, when there is one.
        setMandateId((r.mandates.find((m) => m.id === 'demo-autonomy') ?? r.mandates[0])?.id ?? null);
      })
      .catch(fail);
  }, []);

  const load = useCallback((id: string) => call<AutonomyResponse>(`/api/autonomy?mandateId=${encodeURIComponent(id)}`), []);

  useEffect(() => {
    if (!mandateId) return;
    let live = true;
    load(mandateId)
      .then((d) => {
        if (!live) return;
        setData(d);
        setError(null);
      })
      .catch((err) => live && fail(err));
    return () => {
      live = false;
    };
  }, [mandateId, load]);

  async function accept(s: AutonomySuggestion) {
    setBusy(s.id);
    setError(null);
    try {
      const r = await call<AutonomyAcceptResponse>('/api/autonomy', { mandateId, suggestionId: s.id, decidedBy: approver.trim() });
      setDone(r);
      setData(await load(r.mandate.id));
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  }

  const current = data && data.mandate.id === mandateId ? data : null;
  const open = current?.suggestions.filter((s) => !dismissed.includes(s.id)) ?? [];

  return (
    <Page
      title="Autonomy"
      actions={
        <div className="flex flex-wrap gap-2" role="group" aria-label="Buyer">
          {mandates?.map((m) => (
            <Button
              key={m.id}
              variant={m.id === mandateId ? 'default' : 'outline'}
              className="h-11"
              onClick={() => {
                setMandateId(m.id);
                setDone(null);
              }}
            >
              {m.buyerName}
            </Button>
          ))}
        </div>
      }
    >
      {error && (
        <Alert variant="destructive">
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription className="break-words">{error}</AlertDescription>
        </Alert>
      )}
      {!current && !error && <p className="text-muted-foreground">Loading…</p>}
      {current && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {current.summary.syntheticShare > 0 && <Pill tone="warn">Demo history · {pct(current.summary.syntheticShare)} of reviews</Pill>}
            <Pill>
              Auto-approve up to {euro0(current.mandate.autoApproveLimitEur)} · max {euro0(current.mandate.maxOrderEur)}
            </Pill>
          </div>

          {done && done.mandate.id === current.mandate.id && (
            <Alert>
              <AlertTitle>Limit changed</AlertTitle>
              <AlertDescription>
                {euro0(done.suggestion.from)} → {euro0(done.suggestion.to)}, written to the{' '}
                <Link href="/audit" className="underline">
                  decision record
                </Link>
                .
              </AlertDescription>
            </Alert>
          )}

          {open.length > 0 && (
            <div className="flex flex-wrap items-center gap-3">
              <label htmlFor="approver" className="text-sm font-medium">
                Approver
              </label>
              <Input id="approver" className="h-11 max-w-xs flex-1" value={approver} onChange={(e) => setApprover(e.target.value)} />
            </div>
          )}

          {open.map((s) => (
            <Card key={s.id} s={s} busy={busy === s.id} canAccept={approver.trim().length >= 2 && busy === null} onAccept={() => accept(s)} onDismiss={() => setDismissed((d) => [...d, s.id])} />
          ))}
          {open.length === 0 && (
            <Panel>
              <p className="text-sm">{current.suggestions.length > 0 ? 'Dismissed.' : (current.summary.noSuggestionReason ?? 'Nothing to suggest.')}</p>
            </Panel>
          )}

          <Panel>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-base font-semibold">Orders approved by a person, per month</h2>
              <span className="text-xs text-muted-foreground">
                {current.summary.reviewed} reviewed in {current.summary.windowDays} days
              </span>
            </div>
            <Trajectory months={current.summary.trajectory} />
          </Panel>

          <details className="rounded-xl border bg-card">
            <summary className="min-h-12 cursor-pointer px-5 py-3 text-sm font-medium">How this works</summary>
            <div className="flex flex-col gap-2 border-t px-5 py-4 text-sm text-muted-foreground">
              <p>{current.note}</p>
              <p>
                Plain rules, no model. Raise: at least 12 orders a person reviewed in the last 90 days, up to the new limit, none declined; never above half of the maximum
                order. Lower: 2 of the last 10 decided orders declined or rejected. Only decisions after the last limit change count
                {current.evidenceSince ? ` (here: since ${new Date(current.evidenceSince).toLocaleDateString('en-GB')})` : ''}. A person accepts; the change goes through the mandate update.
              </p>
            </div>
          </details>
        </>
      )}
    </Page>
  );
}

function Card({ s, busy, canAccept, onAccept, onDismiss }: { s: AutonomySuggestion; busy: boolean; canAccept: boolean; onAccept: () => void; onDismiss: () => void }) {
  const raise = s.kind === 'raise_auto_limit';
  return (
    <Panel className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Pill tone={raise ? 'ok' : 'warn'}>{raise ? 'Raise' : 'Lower'}</Pill>
        <span className="text-xl font-semibold">
          {euro0(s.from)} → {euro0(s.to)}
        </span>
        <span className="text-sm text-muted-foreground">auto-approve limit</span>
      </div>
      <p className="text-sm">{s.reason}</p>
      <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
        <div>
          <dt className="inline">Reviewed </dt>
          <dd className="inline font-medium text-foreground">{s.evidence.orders}</dd>
        </div>
        <div>
          <dt className="inline">Approved </dt>
          <dd className="inline font-medium text-foreground">{s.evidence.approved}</dd>
        </div>
        <div>
          <dt className="inline">Declined </dt>
          <dd className="inline font-medium text-foreground">{s.evidence.declined}</dd>
        </div>
        <div>
          <dt className="inline">Auto-approved by size </dt>
          <dd className="inline font-medium text-foreground">
            {pct(s.effect.autoApprovedShareBefore)} → {pct(s.effect.autoApprovedShareAfter)}
          </dd>
        </div>
        {s.evidence.syntheticShare > 0 && <Pill tone="warn">Demo history · {pct(s.evidence.syntheticShare)}</Pill>}
      </dl>
      <div className="flex flex-wrap gap-2">
        <Button className="h-11" disabled={!canAccept} onClick={onAccept}>
          {busy ? 'Saving…' : 'Accept'}
        </Button>
        <Button variant="outline" className="h-11" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </Panel>
  );
}

/** One bar per month: the share of reviewed orders a person approved. */
function Trajectory({ months }: { months: AutonomyMonth[] }) {
  if (months.length === 0) return <p className="mt-3 text-sm text-muted-foreground">No reviewed orders yet.</p>;
  return (
    <ul className="mt-4 grid gap-3" style={{ gridTemplateColumns: `repeat(${months.length}, minmax(0, 1fr))` }}>
      {months.map((m) => (
        <li key={m.month} className="flex flex-col gap-1" title={`${m.approved} of ${m.reviewed} approved`}>
          <div className="flex h-20 items-end rounded-md bg-muted" role="img" aria-label={`${m.month}: ${pct(m.approvalRate)} approved`}>
            <div className="w-full rounded-md bg-primary" style={{ height: `${m.approvalRate * 100}%` }} />
          </div>
          <span className="text-sm font-medium">{pct(m.approvalRate)}</span>
          <span className="text-xs text-muted-foreground">
            {m.month} · {m.reviewed}
          </span>
        </li>
      ))}
    </ul>
  );
}
