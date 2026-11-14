'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from 'cn';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { call, clock, eur } from '@/components/flow/api';
import { DeviationCard } from '@/components/approvals/deviation-card';
import { Page, Panel, Pill } from '@/components/page';
import { ConfirmationLink } from '@/components/verify/confirmation-link';
import { signedDecision } from '@/components/verify/device-key';
import { ReceiptLink } from '@/components/verify/receipt-link';
import type { DeviationReport, ExposedOrder, Mandate, Order } from '@/types';

type Filter = 'pending_approval' | 'all';

/** What the approver sees of the unusual-order check: the report, none recorded, or the approver key was not given. */
type Deviation = { report: DeviationReport } | 'none' | 'locked';

/** Held as unusual: the buyer has a usual order and something in this one differs from it. */
const UNUSUAL = (r: DeviationReport) => r.hasBaseline && r.differing > 0;

const STATUS: Record<Order['status'], { label: string; tone: 'ok' | 'warn' | 'bad' }> = {
  confirmed: { label: 'Approved', tone: 'ok' },
  pending_approval: { label: 'Waiting', tone: 'warn' },
  rejected: { label: 'Declined', tone: 'bad' },
};

/** The human side: orders the mandate would not let the agent place alone. */
export function ApprovalInbox() {
  const [orders, setOrders] = useState<ExposedOrder[] | null>(null);
  const [buyers, setBuyers] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState<Filter>('pending_approval');
  const [approver, setApprover] = useState('Purchasing manager');
  const [note, setNote] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deviations, setDeviations] = useState<Record<string, Deviation>>({});
  const asked = useRef(new Set<string>());

  const refresh = useCallback(async () => {
    try {
      const [o, m] = await Promise.all([
        call<{ orders: ExposedOrder[] }>(filter === 'all' ? '/api/orders' : `/api/orders?status=${filter}`),
        call<{ mandates: Mandate[] }>('/api/mandates'),
      ]);
      setOrders(o.orders);
      setBuyers(Object.fromEntries(m.mandates.map((x) => [x.id, x.buyerName])));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [filter]);

  // Poll, so an order the agent just placed shows up without a reload.
  useEffect(() => {
    const first = setTimeout(() => void refresh(), 0);
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [refresh]);

  // The comparison with the buyer's usual orders is approver-only data: fetched once per waiting order, with the approver key.
  const loadDeviation = useCallback(async (id: string) => {
    try {
      const { report } = await call<{ report: DeviationReport }>(`/api/orders/${id}/deviation`);
      setDeviations((d) => ({ ...d, [id]: { report } }));
    } catch (err) {
      const locked = err instanceof Error && /approver key/i.test(err.message);
      setDeviations((d) => ({ ...d, [id]: locked ? 'locked' : 'none' }));
    }
  }, []);

  useEffect(() => {
    for (const o of orders ?? []) {
      if (o.status !== 'pending_approval' || asked.current.has(o.id)) continue;
      asked.current.add(o.id);
      void loadDeviation(o.id);
    }
  }, [orders, loadDeviation]);

  async function decide(order: ExposedOrder, decision: 'approve' | 'decline', acceptAsNormal = false) {
    setBusy(order.id);
    try {
      const text = note[order.id]?.trim() || undefined;
      await call(`/api/orders/${order.id}/decision`, {
        decision,
        decidedBy: approver,
        note: text,
        ...(acceptAsNormal ? { acceptAsNormal: true } : {}),
        ...(await signedDecision(order.id, decision, approver, text)),
      });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const noApprover = approver.trim().length < 2;

  return (
    <Page
      title="Approvals"
      actions={
        <div className="flex gap-2">
          {(['pending_approval', 'all'] as const).map((f) => (
            <Button
              key={f}
              variant={filter === f ? 'default' : 'outline'}
              className={cn('h-11 px-4', filter === f && 'bg-primary text-primary-foreground hover:bg-petrol-dark')}
              onClick={() => setFilter(f)}
            >
              {f === 'all' ? 'All orders' : 'Waiting'}
            </Button>
          ))}
        </div>
      }
    >
      <Panel className="flex flex-wrap items-center gap-3 px-5 py-4">
        <label htmlFor="approver" className="text-sm font-medium">
          Approver
        </label>
        <Input id="approver" className="h-11 max-w-xs flex-1" value={approver} onChange={(e) => setApprover(e.target.value)} />
        <span className="text-xs text-muted-foreground">Decisions are signed with this browser&apos;s device key.</span>
      </Panel>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription className="break-words">{error}</AlertDescription>
        </Alert>
      )}

      {orders === null && !error && <p className="text-muted-foreground">Loading…</p>}
      {orders?.length === 0 && (
        <Panel className="p-10 text-center text-muted-foreground">
          {filter === 'pending_approval' ? 'Nothing waiting.' : 'No orders yet.'}
        </Panel>
      )}

      <div className="flex flex-col gap-4">
        {orders?.map((o) => {
          const s = STATUS[o.status];
          const pending = o.status === 'pending_approval';
          const dev = pending ? deviations[o.id] : undefined;
          const unusual = typeof dev === 'object' && UNUSUAL(dev.report);
          return (
            <Panel key={o.id} className="flex flex-col gap-3.5">
              <div className="flex flex-wrap items-start justify-between gap-2.5">
                <div className="flex flex-col gap-0.5">
                  <h2 className="text-[17px] font-semibold">{buyers[o.mandateId] ?? o.mandateId}</h2>
                  <p className="text-xs text-muted-foreground">
                    #{o.id.slice(0, 8)} · {clock(o.createdAt)} · delivery {o.deliveryDate}
                  </p>
                </div>
                <div className="flex items-center gap-2.5">
                  <p className="text-2xl font-semibold">{eur(o.total)}</p>
                  <Pill tone={s.tone}>{s.label}</Pill>
                </div>
              </div>

              <ul className="flex flex-col gap-1.5 text-sm">
                {o.lines.map((l) => (
                  <li key={l.productId} className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span>
                      {l.quantity} {l.salesUnit} × {l.name}
                      {l.logisticModel === 'Terminal' && <Pill className="ml-2">Unconfirmed stock</Pill>}
                    </span>
                    <span className="whitespace-nowrap text-muted-foreground">
                      {eur(l.unitPrice)} each · <strong className="text-foreground">{eur(l.lineTotal)}</strong>
                    </span>
                  </li>
                ))}
              </ul>

              {o.policyReasons.length > 0 && (
                <ul className="flex flex-col gap-1.5 border-t pt-3.5">
                  {o.policyReasons.map((r) => (
                    <li key={r} className="flex gap-2 text-[13px] text-muted-foreground">
                      <span aria-hidden="true">•</span>
                      <span>{r}</span>
                    </li>
                  ))}
                </ul>
              )}

              {typeof dev === 'object' && <DeviationCard report={dev.report} />}
              {dev === 'locked' && (
                <p className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
                  The comparison with the buyer&apos;s usual orders needs the approver key.
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setDeviations((d) => Object.fromEntries(Object.entries(d).filter(([k]) => k !== o.id)));
                      void loadDeviation(o.id);
                    }}
                  >
                    Show comparison
                  </Button>
                </p>
              )}

              {pending ? (
                <div className="flex flex-wrap items-center gap-2.5">
                  <Input
                    className="h-11 w-64"
                    placeholder="Note (optional)"
                    value={note[o.id] ?? ''}
                    onChange={(e) => setNote((n) => ({ ...n, [o.id]: e.target.value }))}
                    aria-label="Note"
                  />
                  <Button className="h-11 px-5" onClick={() => decide(o, 'approve')} disabled={busy !== null || noApprover}>
                    {busy === o.id ? 'Saving…' : unusual ? 'Approve this order' : 'Approve'}
                  </Button>
                  <Button variant="outline" className="h-11 px-5" onClick={() => decide(o, 'decline')} disabled={busy !== null || noApprover}>
                    Decline
                  </Button>
                  {unusual && (
                    <Button variant="outline" className="h-11 px-5" onClick={() => decide(o, 'approve', true)} disabled={busy !== null || noApprover}>
                      Approve and accept as new normal
                    </Button>
                  )}
                  {noApprover && <span className="text-xs text-muted-foreground">Name required</span>}
                </div>
              ) : (
                o.decidedBy && (
                  <p className="text-xs text-muted-foreground">
                    {o.status === 'confirmed' ? 'Approved' : 'Declined'} by {o.decidedBy} at {clock(o.decidedAt!)}
                    {o.decisionNote ? `: ${o.decisionNote}` : ''}
                  </p>
                )
              )}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                {o.status !== 'pending_approval' && <ReceiptLink id={o.id} />}
                <ConfirmationLink id={o.id} variant="link" />
              </div>
            </Panel>
          );
        })}
      </div>
    </Page>
  );
}
