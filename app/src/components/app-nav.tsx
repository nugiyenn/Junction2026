'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { cn } from 'cn';
import { call } from '@/components/flow/api';
import type { ExposedOrder } from '@/types';

/** Simple 24px line icons (stroke only), one per page. */
const ICONS: Record<string, string[]> = {
  '/': ['M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'],
  '/approvals': ['M22 11.1V12a10 10 0 1 1-5.9-9.1', 'M22 4 12 14l-3-3'],
  '/exposure': ['M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
  '/audit': ['M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z', 'M14 3v6h6', 'M8 13h8', 'M8 17h8'],
  '/stats': ['M4 20V10', 'M10 20V4', 'M16 20v-7', 'M22 20H2'],
  '/autonomy': ['M4 21v-7', 'M4 10V3', 'M12 21v-9', 'M12 8V3', 'M20 21v-5', 'M20 12V3', 'M1 14h6', 'M9 8h6', 'M17 16h6'],
  '/models': ['M9 3v2', 'M15 3v2', 'M9 19v2', 'M15 19v2', 'M3 9h2', 'M3 15h2', 'M19 9h2', 'M19 15h2', 'M7 5h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z', 'M10 10h4v4h-4z'],
  '/verify': ['M12 2 4 5v6c0 5 3.4 8.4 8 10 4.6-1.6 8-5 8-10V5l-8-3z', 'M9 12l2 2 4-4'],
  '/red-team': ['M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0-18 0', 'M12 12m-4 0a4 4 0 1 0 8 0a4 4 0 1 0-8 0', 'M12 2v4', 'M12 18v4', 'M2 12h4', 'M18 12h4'],
};

const LINKS = [
  { href: '/', label: 'Buyer agent' },
  { href: '/approvals', label: 'Approvals' },
  { href: '/exposure', label: 'What agents see' },
  { href: '/audit', label: 'Decision record' },
  { href: '/stats', label: 'Buyer stats' },
  { href: '/autonomy', label: 'Autonomy' },
  { href: '/models', label: 'Models' },
  { href: '/verify', label: 'Verify' },
  { href: '/red-team', label: 'Red team' },
];

function NavIcon({ href }: { href: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
      {(ICONS[href] ?? []).map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

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
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3l8 3v6c0 4.5-3.2 7.6-8 9-4.8-1.4-8-4.5-8-9V6l8-3z" stroke="#fff" />
              <path d="M8.5 12l2.5 2.5 4.5-5" stroke="#c0e021" />
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
                  active ? 'bg-accent text-accent-foreground shadow-[inset_3px_0_0_var(--lime)]' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                )}
              >
                <NavIcon href={l.href} />
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
