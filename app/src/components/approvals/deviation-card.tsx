'use client';

import { Check } from 'lucide-react';
import { cn } from 'cn';
import type { DeviationCheck, DeviationReport } from '@/types';

/**
 * Why an order is held as unusual, for the approver: the buyer's usual order next to this one. The agent never sees this;
 * it only gets "Needs approval: differs from this buyer's usual orders." (see lib/deviation.ts).
 */
export function DeviationCard({ report }: { report: DeviationReport }) {
  if (!report.hasBaseline) {
    return (
      <p className="rounded-lg bg-muted px-3.5 py-2.5 text-[13px] text-muted-foreground" data-testid="deviation-none">
        No usual order yet. This buyer has too few past orders to compare with, so nothing was flagged as unusual.
      </p>
    );
  }

  const lines = new Set(report.checks.map((c) => c.line).filter(Boolean));
  const showLine = lines.size > 1;
  const verb = report.differing === 1 ? 'differs' : 'differ';

  return (
    <section className="flex flex-col gap-3 border-t pt-3.5" aria-label="Unusual order check" data-testid="deviation-card">
      <h3 className="text-[15px] font-semibold">
        Compared with the last {report.basedOn} approved {report.basedOn === 1 ? 'order' : 'orders'}
      </h3>

      {report.differing > 0 && (
        <p className="rounded-lg bg-warn-soft px-3.5 py-2.5 text-[14px] font-semibold text-warn" data-testid="deviation-summary">
          {report.differing} of {report.total} checks {verb}: {report.findings.join(' ')}
        </p>
      )}

      <div role="table" aria-label="This order compared with the usual order" className="overflow-hidden rounded-lg border text-[13px]">
        <div role="row" className="hidden grid-cols-[1.1fr_1.5fr_1.5fr_1fr] gap-x-3 bg-muted px-3 py-2 text-xs font-semibold text-muted-foreground md:grid">
          <span role="columnheader">Check</span>
          <span role="columnheader">Usual order</span>
          <span role="columnheader">This order</span>
          <span role="columnheader">Result</span>
        </div>
        {report.checks.map((c) => (
          <Row key={c.id} check={c} showLine={showLine} />
        ))}
      </div>

      <p className="text-xs text-muted-foreground">
        The buyer&apos;s agent only sees: &quot;Needs approval: differs from this buyer&apos;s usual orders.&quot; These numbers are for the approver.
      </p>
    </section>
  );
}

function Row({ check: c, showLine }: { check: DeviationCheck; showLine: boolean }) {
  const differs = c.result === 'review';
  const quiet = c.result === 'usual';
  return (
    <div
      role="row"
      data-result={c.result}
      className={cn(
        'grid grid-cols-[1fr_1fr] gap-x-3 gap-y-1 border-t px-3 py-2.5 first:border-t-0 md:grid-cols-[1.1fr_1.5fr_1.5fr_1fr] md:items-baseline',
        differs ? 'bg-warn-soft text-foreground' : 'text-muted-foreground'
      )}
    >
      <span role="cell" className={cn('col-span-2 md:col-span-1', differs ? 'font-semibold text-foreground' : quiet ? '' : 'text-foreground/80')}>
        {c.label}
        {showLine && c.line && <span className="block text-xs font-normal text-muted-foreground">{c.line}</span>}
      </span>
      <span role="cell">
        <span className="block text-[11px] font-semibold uppercase tracking-wide md:hidden">Usual order</span>
        {c.usual}
      </span>
      <span role="cell" className={cn(differs && 'font-bold text-foreground')}>
        <span className="block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground md:hidden">This order</span>
        {c.thisOrder}
      </span>
      <span role="cell" className={cn('col-span-2 md:col-span-1', differs && 'font-bold text-foreground')}>
        <span className="block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground md:hidden">Result</span>
        <span className="flex items-center gap-1.5">
          {quiet && <Check className="size-3.5 shrink-0" aria-hidden="true" />}
          <span>{c.detail ?? (differs ? 'Differs' : 'Same')}</span>
          {differs && <span className="sr-only"> (needs a person)</span>}
        </span>
      </span>
    </div>
  );
}
