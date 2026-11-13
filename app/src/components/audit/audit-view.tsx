'use client';

import { useCallback, useEffect, useState } from 'react';
import { cn } from 'cn';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { call, clock } from '@/components/flow/api';
import { Page, Panel, Pill } from '@/components/page';
import type { ChainStatus } from '@/lib/chain';
import type { AuditEvent } from '@/types';

/** The decision record, with proof that nobody has edited it: each event's hash covers the one before. */
export function AuditView() {
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [chain, setChain] = useState<ChainStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [e, c] = await Promise.all([call<{ events: AuditEvent[] }>('/api/audit'), call<ChainStatus>('/api/audit/verify')]);
      setEvents(e.events);
      setChain(c);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    const timer = setInterval(() => void load(), 6000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [load]);

  async function demo(kind: 'tamper' | 'reset') {
    if (kind === 'reset' && !window.confirm('Delete all quotes, orders and the decision record? A new chain starts.')) return;
    setBusy(kind);
    try {
      await call(`/api/demo/${kind}`, {});
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Page title="Decision record">
      {error && (
        <Alert variant="destructive">
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription className="break-words">{error}</AlertDescription>
        </Alert>
      )}

      {chain && (
        <Panel
          className={cn(
            'flex flex-wrap items-center justify-between gap-3 px-5 py-4',
            chain.valid ? 'border-[#bfddc8] bg-ok-soft' : 'border-[#e7b9ba] bg-bad-soft'
          )}
        >
          <div className={cn('flex flex-col gap-0.5', chain.valid ? 'text-ok' : 'text-destructive')}>
            <p className="font-semibold">{chain.valid ? 'Chain verified' : `Chain broken at event ${chain.brokenAt}`}</p>
            <p className="text-[13px]">
              {chain.valid
                ? `${chain.checked} events. Every hash matches the one before it.`
                : `Its text no longer matches its hash (${chain.reason}). Every event after it can no longer be trusted.`}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" className="h-11 bg-card" onClick={() => demo('tamper')} disabled={busy !== null || !events?.length}>
              Edit an event (demo)
            </Button>
            <Button variant="ghost" className="h-11" onClick={() => demo('reset')} disabled={busy !== null}>
              Reset demo data
            </Button>
          </div>
        </Panel>
      )}

      {chain?.head && (
        <p className="break-all text-xs text-muted-foreground">
          Head hash <code className="font-mono">{chain.head}</code>. Published elsewhere, it also exposes removed events.
        </p>
      )}

      {events?.length === 0 && <p className="text-muted-foreground">Nothing recorded yet.</p>}

      {events && events.length > 0 && (
        <Panel className="px-6 py-5">
          <ol className="flex flex-col gap-5">
            {events.map((e, i) => {
              const bad = chain?.brokenAt != null && e.id === chain.brokenAt;
              return (
                <li key={e.id} className="relative pl-[22px]">
                  {i < events.length - 1 && <span aria-hidden="true" className="absolute top-1.5 -bottom-5 left-[5px] w-0.5 bg-border" />}
                  <span
                    aria-hidden="true"
                    className={cn('absolute top-1.5 left-0 size-3 rounded-full border-2 bg-card', bad ? 'border-destructive bg-bad-soft' : 'border-primary')}
                  />
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <Pill>{e.actor}</Pill>
                      <span className="text-xs text-muted-foreground">{clock(e.at)}</span>
                    </div>
                    <span className="font-mono text-xs text-muted-foreground" title={e.hash ?? 'no hash'}>
                      #{e.id} · {e.hash?.slice(0, 8) ?? '—'}
                    </span>
                  </div>
                  <p className="mt-1.5 text-sm">{e.summary}</p>
                  {bad && (
                    <Pill tone="bad" className="mt-2">
                      First entry that does not verify
                    </Pill>
                  )}
                </li>
              );
            })}
          </ol>
        </Panel>
      )}
    </Page>
  );
}
