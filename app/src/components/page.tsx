import { cn } from 'cn';

/** Page wrapper: consistent width, padding and title row. */
export function Page({ title, actions, children }: { title: string; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 md:px-8 md:py-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[1.75rem] leading-tight font-semibold">{title}</h1>
        {actions}
      </header>
      {children}
    </div>
  );
}

const TONES = {
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  bad: 'bg-bad-soft text-destructive',
  sub: 'bg-sub-soft text-sub',
  plain: 'border border-border bg-muted text-muted-foreground',
} as const;

export type Tone = keyof typeof TONES;

/** A small status label. Tones differ in lightness as well as hue. */
export function Pill({ tone = 'plain', large, className, children }: { tone?: Tone; large?: boolean; className?: string; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full font-semibold whitespace-nowrap',
        large ? 'h-8 px-3.5 text-sm' : 'h-[26px] px-2.5 text-xs',
        TONES[tone],
        className
      )}
    >
      {children}
    </span>
  );
}

export const Panel = ({ className, children, ...rest }: React.ComponentProps<'section'>) => (
  <section className={cn('rounded-2xl border bg-card p-5', className)} {...rest}>
    {children}
  </section>
);
