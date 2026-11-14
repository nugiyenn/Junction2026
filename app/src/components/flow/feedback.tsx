'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { cn } from 'cn';
import type { TextCheck } from '@/lib/text-check';

/** A small spinner in the colour of the text around it. It stands still for people who ask for less motion. */
export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn('inline-block size-4 shrink-0 rounded-full border-2 border-current border-t-transparent motion-safe:animate-spin', className)}
    />
  );
}

/** Whole seconds since this component appeared. Show the component only while waiting, and it starts at 0 each time. */
function useElapsedSeconds() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);
  return seconds;
}

/**
 * Shown while a slow request runs: a spinner, a running clock, and what happens in total. It does not claim to know which
 * step is under way: the server answers once, at the end.
 */
export function WaitPanel({ title, steps, note }: { title: string; steps: string[]; note: string }) {
  const seconds = useElapsedSeconds();
  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-border bg-muted/50 px-4 py-3 text-sm" role="status" aria-live="polite">
      <div className="flex items-center gap-2 font-medium">
        <Spinner />
        <span>{title}</span>
        <span className="ml-auto font-normal tabular-nums text-muted-foreground" aria-hidden="true">
          {seconds} s
        </span>
      </div>
      <ul className="flex list-disc flex-col gap-1 pl-10 text-[13px] text-muted-foreground">
        {steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>
      <p className="pl-6 text-xs text-muted-foreground">{note}</p>
    </div>
  );
}

/** The one line a text check has to say, under the box it is about. Nothing is drawn when there is nothing to say. */
export function TextHint({ check, id }: { check: TextCheck; id?: string }) {
  if (!check.message) return null;
  return (
    <p
      id={id}
      className={cn(
        'flex flex-wrap items-center gap-x-2 text-[13px]',
        check.level === 'block' && 'text-destructive',
        check.level === 'hint' && 'text-warn',
        check.level === 'info' && 'text-muted-foreground'
      )}
    >
      <span>{check.message}</span>
      {check.link && (
        <Link href={check.link.href} className="font-medium underline underline-offset-2">
          {check.link.label}
        </Link>
      )}
    </p>
  );
}
