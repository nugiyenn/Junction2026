'use client';

import { useEffect, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { call } from '@/components/flow/api';
import { Page, Panel, Pill } from '@/components/page';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { EvalModelResult, EvalResults } from '@/types';

/** What each model is used for (a statement about the code, not a measured result). */
const ROLE: Record<string, string> = {
  'gemma-4': 'Reads requests · first choice',
  'qwen-2.5-72b': 'Fallback reader',
  'gemini-3.8-flash': 'Hosted reference · not in request path',
  'gemini-3.1-flash-lite': 'Hosted reference · not in request path',
  nemotron: 'Reads web pages for live checks',
};

const pct = (n: number) => `${Math.round(n * 100)}%`;
const secs = (ms: number | null) => (ms === null ? '–' : `${(ms / 1000).toFixed(1)} s`);
const answer = (a: [number, string] | null | undefined) => (a ? `${a[0]} ${a[1]}` : 'no answer');

function ModelRow({ m }: { m: EvalModelResult }) {
  const s = m.summary;
  return (
    <TableRow>
      <TableCell className="min-w-56 whitespace-normal">
        <div className="font-medium">{m.label}</div>
        <div className="text-xs text-muted-foreground">{ROLE[m.id]}</div>
      </TableCell>
      {s ? (
        <>
          <TableCell>{pct(s.validRate)}</TableCell>
          <TableCell>{pct(s.fieldAccuracy.amount)}</TableCell>
          <TableCell>{pct(s.fieldAccuracy.amountUnit)}</TableCell>
          <TableCell>{pct(s.fieldAccuracy.requiredClaims)}</TableCell>
          <TableCell>{pct(s.fieldAccuracy.deliveryDate)}</TableCell>
          <TableCell className="font-medium">{pct(s.exactRate)}</TableCell>
          <TableCell>{secs(s.latencyP50Ms)}</TableCell>
          <TableCell>{secs(s.latencyP95Ms)}</TableCell>
        </>
      ) : (
        <TableCell colSpan={8}>
          <Pill tone="warn">Not run · {m.reason}</Pill>
        </TableCell>
      )}
    </TableRow>
  );
}

/** The model evaluation: same requests, same prompt and schema for every model, scored against hand labels. */
export function ModelsView() {
  const [data, setData] = useState<EvalResults | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    call<EvalResults>('/api/models')
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const ran = data?.models.filter((m) => m.status === 'ran') ?? [];
  const disagreements = data?.agreement.filter((a) => a.agree === false || a.wrong.length > 0) ?? [];

  return (
    <Page title="Models">
      {error && (
        <Alert variant="destructive">
          <AlertTitle>Could not load the evaluation</AlertTitle>
          <AlertDescription className="break-words">{error}</AlertDescription>
        </Alert>
      )}

      {data && (
        <>
          <Panel className="overflow-x-auto">
            <h2 className="mb-3 text-base font-semibold">Request reading · {data.caseCount} labelled cases</h2>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Model</TableHead>
                  <TableHead>Valid JSON</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Unit</TableHead>
                  <TableHead>Claims</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>All fields</TableHead>
                  <TableHead>p50</TableHead>
                  <TableHead>p95</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.models.map((m) => (
                  <ModelRow key={m.id} m={m} />
                ))}
              </TableBody>
            </Table>
            <p className="mt-3 text-xs text-muted-foreground">
              Run {new Date(data.generatedAt).toLocaleDateString('en-GB')} · prompt {data.today} · failed call = wrong · latency over valid answers
            </p>
          </Panel>

          <Panel>
            <h2 className="text-base font-semibold">Model agreement</h2>
            {data.agreementSummary.comparable > 0 ? (
              <dl className="m-0 mt-3 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 text-sm">
                <dt className="text-muted-foreground">Same amount and unit</dt>
                <dd className="font-semibold">
                  {data.agreementSummary.agreed} / {data.agreementSummary.comparable}
                </dd>
                <dt className="text-muted-foreground">All match label</dt>
                <dd className="font-semibold">
                  {data.agreementSummary.allCorrect} / {data.agreementSummary.comparable}
                </dd>
                {ran.length < data.models.length && (
                  <>
                    <dt className="text-muted-foreground">Models not run</dt>
                    <dd className="font-semibold">{data.models.length - ran.length}</dd>
                  </>
                )}
              </dl>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">Fewer than two models answered.</p>
            )}
            {disagreements.length > 0 && (
              <details className="mt-3">
                <summary className="min-h-9 cursor-pointer py-1.5 text-sm text-primary">Disagreements ({disagreements.length})</summary>
                <ul className="mt-2 flex flex-col gap-3">
                  {disagreements.map((a) => (
                    <li key={a.caseId} className="rounded-xl border p-3 text-sm">
                      <div className="font-medium">“{a.text}”</div>
                      <div className="text-muted-foreground">Label · {answer(a.expected)}</div>
                      <div className="mt-1 flex flex-wrap gap-2">
                        {data.models
                          .filter((m) => m.status === 'ran')
                          .map((m) => (
                            <Pill key={m.id} tone={!a.answers[m.id] ? 'plain' : a.wrong.includes(m.id) ? 'bad' : 'ok'}>
                              {m.label}: {answer(a.answers[m.id])}
                            </Pill>
                          ))}
                      </div>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </Panel>
        </>
      )}
    </Page>
  );
}
