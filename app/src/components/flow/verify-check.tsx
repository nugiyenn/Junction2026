'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Panel, Pill, type Tone } from '@/components/page';
import type { LiveChecks, RecallCheck, Verification } from '@/types';
import { allergenName, call } from './api';

const STATUS: Record<Verification['status'], { label: string; tone: Tone }> = {
  confirmed: { label: 'Confirmed', tone: 'ok' },
  contradiction: { label: 'Source disagrees', tone: 'bad' },
  no_evidence: { label: 'No evidence', tone: 'plain' },
  unreadable: { label: 'Unreadable', tone: 'plain' },
};

const STANCE: Record<string, string> = { contains: 'contains', may_contain: 'may contain', free_from: 'free from' };

/** Checks one product's allergen and label claims against the live web (explicit action: it spends live calls). */
export function VerifyCheck({ productId, name }: { productId: string; name: string }) {
  const [result, setResult] = useState<Verification | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      setResult((await call<{ verification: Verification }>(`/api/products/${productId}/verify`, {})).verification);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3 text-[13px]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="min-w-0 flex-1 basis-48 font-medium" title={name}>
          {name}
        </span>
        {result && <Pill tone={STATUS[result.status].tone}>{STATUS[result.status].label}</Pill>}
        <Button variant="outline" className="h-9" onClick={run} disabled={busy}>
          {busy ? 'Reading…' : result ? 'Re-check' : 'Check sources'}
        </Button>
      </div>

      {error && <p className="text-destructive">{error}</p>}

      {result && (
        <>
          <details>
            <summary className="min-h-9 cursor-pointer py-1.5 text-primary">Summary and sources ({result.sources.length})</summary>
            <div className="flex flex-col gap-2 pt-1">
              <p className="text-muted-foreground">{result.summary}</p>
              {result.statements.map((s, i) => (
                <p key={i} className="text-muted-foreground">
                  <strong className="text-foreground">
                    {s.topic === 'allergen' && s.allergen ? `${STANCE[s.stance ?? ''] ?? ''} ${allergenName(s.allergen)}` : s.topic}
                  </strong>
                  : “{s.evidence.replace(/\s+/g, ' ')}”{' '}
                  <a href={s.sourceUrl} target="_blank" rel="noreferrer" className="text-primary underline">
                    source
                  </a>
                </p>
              ))}
              <ul className="text-xs text-muted-foreground">
                {result.sources.map((s) => (
                  <li key={s.url}>
                    <a href={s.url} target="_blank" rel="noreferrer" className="text-primary underline">
                      {new URL(s.url).hostname}
                    </a>
                    {s.note ? `: ${s.note}` : ''}
                    {s.requestId ? ` · Oxylabs request ${s.requestId}` : ''}
                  </li>
                ))}
              </ul>
            </div>
          </details>
        </>
      )}
    </div>
  );
}

const RECALL: Record<RecallCheck['status'], { label: string; tone: Tone }> = {
  none_found: { label: 'No recall', tone: 'ok' },
  match: { label: 'Recall notice', tone: 'bad' },
  unreadable: { label: 'Recall unreadable', tone: 'plain' },
};

const hostname = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

/** Automatic live web checks for the ordered products: allergen and label claims, recall notices. Checks that did not run are shown. */
export function LiveChecksSummary({ checks }: { checks: LiveChecks }) {
  return (
    <Panel className="flex flex-col gap-3" aria-label="Live web checks">
      <h2 className="text-[17px] font-semibold">Live web checks</h2>
      {checks.products.map((p) => (
        <div key={p.productId} className="flex flex-col gap-1.5 text-[13px]">
          <span className="font-medium">{p.name}</span>
          <div className="flex flex-wrap gap-1.5">
            {p.verification && <Pill tone={STATUS[p.verification.status].tone}>{STATUS[p.verification.status].label}</Pill>}
            {p.recall && <Pill tone={RECALL[p.recall.status].tone}>{RECALL[p.recall.status].label}</Pill>}
          </div>
          {p.skipped.map((s) => (
            <p key={s} className="text-xs text-destructive">
              {s}
            </p>
          ))}
          {p.recall?.matches.map((m) => (
            <p key={m.sourceUrl} className="text-xs text-muted-foreground">
              “{m.quote.replace(/[*\s]+/g, ' ')}”{' '}
              <a href={m.sourceUrl} target="_blank" rel="noreferrer" className="text-primary underline">
                notice
              </a>
            </p>
          ))}
        </div>
      ))}
      <details>
        <summary className="min-h-9 cursor-pointer py-1.5 text-[13px] text-primary">Sources and models</summary>
        <div className="flex flex-col gap-3 pt-1 text-xs text-muted-foreground">
          {checks.products.map((p) => {
            const sources = [
              ...(p.verification?.sources.map((s) => ({ ...s, kind: 'Allergens and labels' })) ?? []),
              ...(p.recall?.sources.map((s) => ({ ...s, kind: 'Recalls' })) ?? []),
            ];
            return (
              <div key={p.productId} className="flex flex-col gap-1">
                <strong className="text-foreground">{p.name}</strong>
                {(p.verification?.model || p.recall?.model) && (
                  <p>
                    {p.verification?.model && <>Pages read by {p.verification.model}. </>}
                    {p.recall?.model && <>Recall notices read by {p.recall.model}.</>}
                  </p>
                )}
                {p.recall && (
                  <p>
                    Recall search: <code>{p.recall.query}</code>
                    {p.recall.searchRequestId ? ` · Oxylabs request ${p.recall.searchRequestId}` : ''}
                  </p>
                )}
                {p.verification?.searchRequestId && <p>Claims search · Oxylabs request {p.verification.searchRequestId}</p>}
                <ul>
                  {sources.map((s) => (
                    <li key={`${s.kind}-${s.url}`}>
                      {s.kind}:{' '}
                      <a href={s.url} target="_blank" rel="noreferrer" className="text-primary underline">
                        {hostname(s.url)}
                      </a>
                      {s.note ? `: ${s.note}` : ''}
                      {s.requestId ? ` · Oxylabs request ${s.requestId}` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </details>
    </Panel>
  );
}
