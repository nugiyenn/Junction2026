'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Pill, type Tone } from '@/components/page';
import type { Verification } from '@/types';
import { allergenName, call } from './api';

const STATUS: Record<Verification['status'], { label: string; tone: Tone }> = {
  confirmed: { label: 'Confirmed on the web', tone: 'ok' },
  contradiction: { label: 'Source disagrees', tone: 'bad' },
  no_evidence: { label: 'No evidence found', tone: 'plain' },
  unreadable: { label: 'Sources unreadable', tone: 'plain' },
};

const STANCE: Record<string, string> = { contains: 'contains', may_contain: 'may contain', free_from: 'free from' };

/**
 * Checks one product's allergen and label claims against the live web (Oxylabs search + scrape).
 * It is an explicit action, because it spends live calls and takes up to a couple of minutes.
 */
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
    <div className="flex flex-col gap-2 rounded-[10px] border p-3 text-[13px]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="min-w-0 flex-1 basis-48 font-medium" title={name}>
          {name}
        </span>
        {result && <Pill tone={STATUS[result.status].tone}>{STATUS[result.status].label}</Pill>}
        <Button variant="outline" className="h-9" onClick={run} disabled={busy}>
          {busy ? 'Reading sources…' : result ? 'Re-check' : 'Check sources'}
        </Button>
      </div>

      {error && <p className="text-destructive">{error}</p>}

      {result && (
        <>
          <p className="text-muted-foreground">{result.summary}</p>
          <details>
            <summary className="min-h-9 cursor-pointer py-1.5 text-primary">Show sources</summary>
            <div className="flex flex-col gap-2 pt-1">
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
