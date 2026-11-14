'use client';

import { useEffect, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { call, eur } from '@/components/flow/api';
import { Page, Panel, Pill, type Tone } from '@/components/page';
import type { BuyerStats, InfraStatus, Mandate, OrderOutcome } from '@/types';

const OUTCOMES: { key: OrderOutcome; label: string; bar: string }[] = [
  { key: 'auto_approved', label: 'Auto-approved', bar: 'bg-primary' },
  { key: 'approved', label: 'Approved', bar: 'bg-primary/55' },
  { key: 'declined', label: 'Declined', bar: 'bg-warn' },
  { key: 'rejected', label: 'Rejected', bar: 'bg-destructive' },
  { key: 'pending', label: 'Waiting', bar: 'bg-muted-foreground/40' },
];

const duration = (s: number | null) => (s === null ? '–' : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);

export function StatsView() {
  const [mandates, setMandates] = useState<Mandate[] | null>(null);
  const [mandateId, setMandateId] = useState<string | null>(null);
  const [stats, setStats] = useState<BuyerStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    call<{ mandates: Mandate[] }>('/api/mandates')
      .then((r) => {
        setMandates(r.mandates);
        setMandateId(r.mandates[0]?.id ?? null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    if (!mandateId) return;
    let live = true;
    call<BuyerStats>(`/api/stats?mandateId=${encodeURIComponent(mandateId)}`)
      .then((s) => {
        if (!live) return;
        setStats(s);
        setError(null);
      })
      .catch((err) => live && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      live = false;
    };
  }, [mandateId]);

  const current = stats && stats.mandateId === mandateId ? stats : null;

  return (
    <Page
      title="Buyer stats"
      actions={
        <div className="flex flex-wrap gap-2" role="group" aria-label="Buyer">
          {mandates?.map((m) => (
            <Button key={m.id} variant={m.id === mandateId ? 'default' : 'outline'} className="h-11" onClick={() => setMandateId(m.id)}>
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
      {current && <Stats s={current} />}
    </Page>
  );
}

function Stats({ s }: { s: BuyerStats }) {
  const confirmedCount = s.outcomes.auto_approved + s.outcomes.approved;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {s.totals.syntheticOrders > 0 && <Pill tone="warn">Demo history · {s.totals.syntheticOrders}</Pill>}
        <Pill tone="ok">Real orders · {s.totals.realOrders}</Pill>
        <Pill>{s.source === 'clickhouse' ? 'ClickHouse' : 'Postgres'}</Pill>
      </div>

      {s.totals.orders === 0 ? (
        <p className="text-muted-foreground">No orders yet.</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Tile label="Confirmed spend" value={eur(s.totals.confirmedSpend)} note={`${confirmedCount} orders · ex VAT`} />
            <Tile label="Median order" value={eur(s.orderSize?.median)} note={`p90 ${eur(s.orderSize?.p90)}`} />
            <Tile label="Decision time" value={duration(s.avgDecisionSeconds)} note="average, human" />
            <Tile label="Carbon" value={s.avgCo2PerKg === null ? '–' : `${s.avgCo2PerKg.toFixed(2)}`} note="kg CO₂-eq/kg · avg" />
            <Tile label="Reliability" value={s.avgReliability === null ? '–' : `${(s.avgReliability * 100).toFixed(1)} %`} note="avg per line" />
            <Tile label="Orders" value={String(s.totals.orders)} note="all outcomes" />
          </div>

          <Panel>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-base font-semibold">Spend per week</h2>
              <span className="flex items-center gap-3 text-xs text-muted-foreground">
                <Key className="bg-primary/40" label="Demo history" />
                <Key className="bg-primary" label="Real orders" />
              </span>
            </div>
            <Weeks weeks={s.weeks} />
          </Panel>

          <div className="grid gap-6 md:grid-cols-2">
            <Panel>
              <h2 className="text-base font-semibold">Outcomes</h2>
              <div className="mt-3 flex h-3 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                {OUTCOMES.map((o) => (
                  <div key={o.key} className={o.bar} style={{ width: `${(s.outcomes[o.key] / s.totals.orders) * 100}%` }} />
                ))}
              </div>
              <ul className="mt-4 flex flex-col gap-2 text-sm">
                {OUTCOMES.map((o) => (
                  <li key={o.key} className="flex items-center gap-2">
                    <span className={`size-3 rounded-full ${o.bar}`} aria-hidden="true" />
                    {o.label}
                    <span className="ml-auto font-medium">{s.outcomes[o.key]}</span>
                    <span className="w-12 text-right text-muted-foreground">{Math.round((s.outcomes[o.key] / s.totals.orders) * 100)} %</span>
                  </li>
                ))}
              </ul>
            </Panel>

            <Panel>
              <h2 className="text-base font-semibold">Top products</h2>
              <ol className="mt-3 flex flex-col gap-2 text-sm">
                {s.topProducts.map((p) => (
                  <li key={p.productId} className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate" title={p.name}>
                      {p.name}
                    </span>
                    <span className="text-muted-foreground">{p.orders} orders</span>
                    <span className="w-24 text-right font-medium">{eur(p.spend)}</span>
                  </li>
                ))}
              </ol>
            </Panel>
          </div>
        </>
      )}

      <details className="rounded-xl border bg-card">
        <summary className="flex min-h-12 cursor-pointer flex-wrap items-center gap-2 px-5 py-3 text-sm font-medium">
          Infrastructure
          {s.infra.map((i) => (
            <Pill key={i.name} tone={infraTone(i)}>
              {i.name === 'kafka' ? 'Kafka' : 'ClickHouse'} · {infraLabel(i)}
            </Pill>
          ))}
        </summary>
        <div className="border-t px-5 py-4">
          <ul className="flex flex-col gap-2 text-sm">
            {s.infra.map((i) => (
              <li key={i.name} className="flex flex-wrap items-start gap-2">
                <Pill tone={infraTone(i)} className="shrink-0 md:w-64 md:justify-center">
                  {i.name === 'kafka' ? 'Aiven Kafka' : 'Aiven ClickHouse'} · {infraLabel(i)}
                </Pill>
                <span className="min-w-0 flex-1 break-words text-muted-foreground">{i.detail}</span>
              </li>
            ))}
          </ul>
          {s.stream && (
            <p className="mt-3 text-xs text-muted-foreground">
              ClickHouse events:{' '}
              {Object.entries(s.stream.byAction)
                .map(([a, n]) => `${a.replaceAll('_', ' ')} ${n}`)
                .join(', ') || 'none'}
            </p>
          )}
        </div>
      </details>
    </>
  );
}

const infraLabel = (i: InfraStatus) => (!i.configured ? 'not configured' : i.ok === null ? 'unchecked' : i.ok ? 'ok' : 'failing');
const infraTone = (i: InfraStatus): Tone => (!i.configured || i.ok === null ? 'plain' : i.ok ? 'ok' : 'bad');

function Tile({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <Panel className="flex flex-col gap-1 p-4">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-xl font-semibold">{value}</span>
      <span className="text-xs text-muted-foreground">{note}</span>
    </Panel>
  );
}

const Key = ({ className, label }: { className: string; label: string }) => (
  <span className="flex items-center gap-1.5">
    <span className={`size-3 rounded-sm ${className}`} aria-hidden="true" />
    {label}
  </span>
);

/** Stacked bars, one per week: demo history below, real orders on top. */
function Weeks({ weeks }: { weeks: BuyerStats['weeks'] }) {
  const max = Math.max(...weeks.map((w) => w.spend), 1);
  return (
    <div className="mt-4 overflow-x-auto">
      <div className="flex h-44 min-w-[28rem] items-end gap-1.5" role="img" aria-label="Confirmed spend per week">
        {weeks.map((w) => (
          <div key={w.week} className="flex h-full flex-1 flex-col justify-end" title={`Week of ${w.week}: ${eur(w.spend)} confirmed, ${w.orders} orders`}>
            <div className="bg-primary" style={{ height: `${((w.spend - w.syntheticSpend) / max) * 100}%` }} />
            <div className="rounded-b-sm bg-primary/40" style={{ height: `${(w.syntheticSpend / max) * 100}%` }} />
          </div>
        ))}
      </div>
      <div className="mt-1 flex min-w-[28rem] justify-between text-xs text-muted-foreground">
        <span>Week of {weeks[0]?.week}</span>
        <span>max {eur(max)}</span>
        <span>{weeks[weeks.length - 1]?.week}</span>
      </div>
    </div>
  );
}
