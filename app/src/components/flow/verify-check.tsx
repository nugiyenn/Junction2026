'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { Verification } from '@/types';
import { allergenName, call } from './api';

const STATUS: Record<Verification['status'], { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  confirmed: { label: 'Verified on the web', variant: 'default' },
  contradiction: { label: 'Source disagrees', variant: 'destructive' },
  no_evidence: { label: 'No evidence found', variant: 'secondary' },
  unreadable: { label: 'Sources unreadable', variant: 'secondary' },
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
    <div className="flex flex-col gap-1.5 border-t pt-2 text-xs">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-muted-foreground" title={name}>
          {name}
        </span>
        {result && <Badge variant={STATUS[result.status].variant}>{STATUS[result.status].label}</Badge>}
        <Button size="xs" variant="outline" onClick={run} disabled={busy}>
          {busy ? 'Reading sources…' : result ? 'Re-check' : 'Check sources'}
        </Button>
      </div>

      {error && <p className="text-destructive">{error}</p>}

      {result && (
        <div className="flex flex-col gap-1">
          <p>{result.summary}</p>
          {result.statements.map((s, i) => (
            <p key={i} className="text-muted-foreground">
              <strong className="text-foreground">
                {s.topic === 'allergen' && s.allergen ? `${STANCE[s.stance ?? ''] ?? ''} ${allergenName(s.allergen)}` : s.topic}
              </strong>
              : “{s.evidence.replace(/\s+/g, ' ')}”{' '}
              <a href={s.sourceUrl} target="_blank" rel="noreferrer" className="underline">
                source
              </a>
            </p>
          ))}
          <ul className="text-muted-foreground">
            {result.sources.map((s) => (
              <li key={s.url}>
                <a href={s.url} target="_blank" rel="noreferrer" className="underline">
                  {new URL(s.url).hostname}
                </a>
                {s.note ? `: ${s.note}` : ''}
                {s.requestId ? ` · Oxylabs request ${s.requestId}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
