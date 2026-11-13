'use client';

import { useCallback, useEffect, useState } from 'react';
import { cn } from 'cn';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { call, clock, eur } from '@/components/flow/api';
import { Page, Panel, Pill } from '@/components/page';
import type { ExposedOrder, Mandate, Order } from '@/types';

type Filter = 'pending_approval' | 'all';

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

  async function decide(order: ExposedOrder, decision: 'approve' | 'decline') {
    setBusy(order.id);
    try {
      await call(`/api/orders/${order.id}/decision`, { decision, decidedBy: approver, note: note[order.id]?.trim() || undefined });
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
              className={cn('h-11 rounded-full px-4', filter === f && 'bg-foreground text-background hover:bg-foreground/90')}
              onClick={() => setFilter(f)}
            >
              {f === 'all' ? 'All orders' : 'Waiting'}
            </Button>
          ))}
        </div>
      }
    >
      <Panel className="flex flex-wrap items-center gap-4 px-5 py-4">
        <div className="flex flex-[1_1_240px] flex-col gap-1.5">
          <label htmlFor="approver" className="text-xs font-medium tracking-wide text-muted-foreground">
            Your name, recorded with every decision
          </label>
          <Input id="approver" className="h-11" value={approver} onChange={(e) => setApprover(e.target.value)} />
        </div>
        <p className="flex-[1_1_260px] text-[13px] text-muted-foreground">Only a person can approve or decline. The agent and its tools have no way to do it.</p>
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
          {filter === 'pending_approval' ? 'Nothing is waiting for you.' : 'No orders yet.'} Send a request from the Buyer agent page.
        </Panel>
      )}

      <div className="flex flex-col gap-4">
        {orders?.map((o) => {
          const s = STATUS[o.status];
          const pending = o.status === 'pending_approval';
          return (
            <Panel key={o.id} className="flex flex-col gap-3.5">
              <div className="flex flex-wrap items-start justify-between gap-2.5">
                <div className="flex flex-col gap-0.5">
                  <h2 className="text-[17px] font-semibold">{buyers[o.mandateId] ?? o.mandateId}</h2>
                  <p className="text-xs text-muted-foreground">
                    Order {o.id.slice(0, 8)} · placed {clock(o.createdAt)} · delivery {o.deliveryDate}
                  </p>
                </div>
                <div className="flex items-center gap-2.5">
                  <p className="font-heading text-2xl font-semibold">{eur(o.total)}</p>
                  <Pill tone={s.tone}>{s.label}</Pill>
                </div>
              </div>

              <ul className="flex flex-col gap-1 text-sm">
                {o.lines.map((l) => (
                  <li key={l.productId}>
                    {l.quantity} {l.salesUnit} × {l.name} · {eur(l.unitPrice)} each = <strong>{eur(l.lineTotal)}</strong>
                    {l.logisticModel === 'Terminal' && <span className="text-muted-foreground"> · supplier stock, unconfirmed</span>}
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
                    {busy === o.id ? 'Saving…' : 'Approve'}
                  </Button>
                  <Button variant="outline" className="h-11 px-5 text-destructive" onClick={() => decide(o, 'decline')} disabled={busy !== null || noApprover}>
                    Decline
                  </Button>
                  {noApprover && <span className="text-xs text-muted-foreground">Enter your name first.</span>}
                </div>
              ) : (
                o.decidedBy && (
                  <p className="text-xs text-muted-foreground">
                    {o.status === 'confirmed' ? 'Approved' : 'Declined'} by {o.decidedBy} at {clock(o.decidedAt!)}
                    {o.decisionNote ? `: ${o.decisionNote}` : ''}. Written to the decision record.
                  </p>
                )
              )}
            </Panel>
          );
        })}
      </div>
    </Page>
  );
}
