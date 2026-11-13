'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { call, clock } from '@/components/flow/api';
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

  const brokenIndex = chain?.brokenAt ? events?.findIndex((e) => e.id === chain.brokenAt) ?? -1 : -1;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Decision record</h1>
        <p className="text-muted-foreground">
          What every agent and human did, and why, in plain language. Visible to both the buyer and Valio Aimo. Each entry is
          hash-chained to the one before it, so neither side can quietly rewrite history.
        </p>
      </header>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription className="break-words">{error}</AlertDescription>
        </Alert>
      )}

      {chain && (
        <Card className={chain.valid ? undefined : 'border-destructive'}>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">
              Chain integrity
              <Badge variant={chain.valid ? 'default' : 'destructive'}>{chain.valid ? 'Verified' : 'Broken'}</Badge>
            </CardTitle>
            <CardDescription>
              {chain.valid
                ? `${chain.checked} event(s) re-computed from the first; every hash matches.`
                : `Event #${chain.brokenAt} does not verify: ${chain.reason}.`}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            {chain.head && (
              <p className="break-all">
                Head hash: <code className="text-xs">{chain.head}</code>
                <span className="text-muted-foreground"> Publish it somewhere else, and even removing the newest events would show.</span>
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" onClick={() => demo('tamper')} disabled={busy !== null || !events?.length}>
                Demo: edit an old entry in the database
              </Button>
              <Button variant="ghost" onClick={() => demo('reset')} disabled={busy !== null}>
                Reset demo data
              </Button>
              <span className="text-xs text-muted-foreground">The first simulates tampering, to show the chain catching it.</span>
            </div>
          </CardContent>
        </Card>
      )}

      {events?.length === 0 && <p className="text-muted-foreground">Nothing recorded yet.</p>}

      {events && events.length > 0 && (
        <Card>
          <CardContent>
            <ol className="flex flex-col gap-3 text-sm">
              {events.map((e) => {
                const bad = brokenIndex >= 0 && e.id === chain?.brokenAt;
                return (
                  <li key={e.id} className={`flex flex-col gap-1 rounded-md p-2 ${bad ? 'bg-destructive/10' : ''}`}>
                    <div className="flex items-start gap-3">
                      <span className="w-12 shrink-0 font-mono text-xs text-muted-foreground">{clock(e.at)}</span>
                      <Badge variant="outline" className="w-16 shrink-0">
                        {e.actor}
                      </Badge>
                      <span className="flex-1">{e.summary}</span>
                      <span className="shrink-0 font-mono text-xs text-muted-foreground" title={e.hash ?? 'no hash'}>
                        #{e.id} · {e.hash?.slice(0, 8) ?? '—'}
                      </span>
                    </div>
                    {bad && <p className="pl-[7.5rem] text-xs text-destructive">This is the first entry that does not verify: {chain?.reason}.</p>}
                  </li>
                );
              })}
            </ol>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
