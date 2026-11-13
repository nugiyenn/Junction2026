'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { call, clock, eur } from '@/components/flow/api';
import type { ExposedOrder, Mandate, Order } from '@/types';

type Filter = 'pending_approval' | 'all';

const STATUS: Record<Order['status'], { label: string; variant: 'default' | 'secondary' | 'destructive' }> = {
  confirmed: { label: 'Confirmed', variant: 'default' },
  pending_approval: { label: 'Awaiting approval', variant: 'secondary' },
  rejected: { label: 'Rejected', variant: 'destructive' },
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

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-8">
      <header className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Approvals</h1>
          <p className="text-muted-foreground">Orders the agent may not place alone. Prices are held until the quote expires.</p>
        </div>
        <div className="ml-auto flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">You are</span>
          <Input className="w-48" value={approver} onChange={(e) => setApprover(e.target.value)} aria-label="Your name" />
          <Button variant={filter === 'pending_approval' ? 'default' : 'outline'} onClick={() => setFilter('pending_approval')}>
            Waiting
          </Button>
          <Button variant={filter === 'all' ? 'default' : 'outline'} onClick={() => setFilter('all')}>
            All orders
          </Button>
        </div>
      </header>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription className="break-words">{error}</AlertDescription>
        </Alert>
      )}

      {orders === null && !error && <p className="text-muted-foreground">Loading…</p>}
      {orders?.length === 0 && (
        <p className="text-muted-foreground">
          {filter === 'pending_approval' ? 'Nothing is waiting for approval.' : 'No orders yet.'} Send a request from the Buyer agent page.
        </p>
      )}

      {orders?.map((o) => (
        <Card key={o.id}>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">
              {buyers[o.mandateId] ?? o.mandateId}
              <Badge variant={STATUS[o.status].variant}>{STATUS[o.status].label}</Badge>
              <span className="ml-auto text-xl">{eur(o.total)}</span>
            </CardTitle>
            <CardDescription>
              Order {o.id.slice(0, 8)} · placed {clock(o.createdAt)} · delivery {o.deliveryDate} · {eur(o.totalWithTax)} incl. VAT
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <ul className="flex flex-col gap-1">
              {o.lines.map((l) => (
                <li key={l.productId}>
                  {l.quantity} {l.salesUnit} × {l.name} · {eur(l.unitPrice)} each ={' '}
                  <strong>{eur(l.lineTotal)}</strong>
                  {l.logisticModel === 'Terminal' && <span className="text-muted-foreground"> · supplier stock, unconfirmed</span>}
                </li>
              ))}
            </ul>

            {o.policyReasons.length > 0 && (
              <div>
                <div className="font-medium">Needs you because</div>
                <ul className="list-disc pl-5">
                  {o.policyReasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </div>
            )}

            {o.status === 'pending_approval' ? (
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  className="w-64"
                  placeholder="Note (optional)"
                  value={note[o.id] ?? ''}
                  onChange={(e) => setNote((n) => ({ ...n, [o.id]: e.target.value }))}
                />
                <Button onClick={() => decide(o, 'approve')} disabled={busy !== null || !approver.trim()}>
                  {busy === o.id ? 'Saving…' : 'Approve'}
                </Button>
                <Button variant="destructive" onClick={() => decide(o, 'decline')} disabled={busy !== null || !approver.trim()}>
                  Decline
                </Button>
              </div>
            ) : (
              o.decidedBy && (
                <p className="text-muted-foreground">
                  {o.status === 'confirmed' ? 'Approved' : 'Declined'} by {o.decidedBy} at {clock(o.decidedAt!)}
                  {o.decisionNote ? `: ${o.decisionNote}` : ''}
                </p>
              )
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
