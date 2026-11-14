'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { cn } from 'cn';
import { call } from '@/components/flow/api';
import type { ExposedOrder } from '@/types';

const LINKS = [
  { href: '/', label: 'Buyer agent' },
  { href: '/approvals', label: 'Approvals' },
  { href: '/exposure', label: 'What agents see' },
  { href: '/audit', label: 'Decision record' },
  { href: '/stats', label: 'Buyer stats' },
  { href: '/models', label: 'Models' },
  { href: '/verify', label: 'Verify' },
];

/** Sidebar on wide screens, a scrolling bar on phones. The Approvals link shows how many orders are waiting. */
export function AppNav() {
  const pathname = usePathname();
  const [waiting, setWaiting] = useState(0);

  useEffect(() => {
    const load = () =>
      call<{ orders: ExposedOrder[] }>('/api/orders?status=pending_approval')
        .then((r) => setWaiting(r.orders.length))
        .catch(() => setWaiting(0));
    const first = setTimeout(load, 0);
    const timer = setInterval(load, 8000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [pathname]);

  return (
    <header className="shrink-0 border-b bg-sidebar md:sticky md:top-0 md:h-screen md:w-60 md:border-r md:border-b-0">
      <div className="flex flex-col gap-3 px-4 py-4 md:gap-6 md:px-4 md:py-5">
        <Link href="/" className="flex items-center gap-3 px-2">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-primary" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3l8 3v6c0 4.5-3.2 7.6-8 9-4.8-1.4-8-4.5-8-9V6l8-3z" />
              <path d="M8.5 12l2.5 2.5 4.5-5" />
            </svg>
          </span>
          <span className="flex flex-col">
            <span className="font-heading text-base leading-tight font-semibold">Trusted Trade</span>
            <span className="text-xs text-muted-foreground">Valio Aimo</span>
          </span>
        </Link>
        <nav aria-label="Main" className="-mx-1 flex gap-1 overflow-x-auto md:mx-0 md:flex-col md:overflow-visible">
          {LINKS.map((l) => {
            const active = pathname === l.href;
            return (
              <Link
                key={l.href}
                href={l.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex min-h-11 shrink-0 items-center gap-2 rounded-[10px] px-3 text-sm font-medium whitespace-nowrap transition-colors',
                  active ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                )}
              >
                {l.label}
                {l.href === '/approvals' && waiting > 0 && (
                  <span className="ml-auto inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-full bg-warn-soft px-1.5 text-xs font-semibold text-warn">
                    {waiting}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
