'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { cn } from 'cn';
import { call } from '@/components/flow/api';
import type { ExposedOrder } from '@/types';

const LINKS = [
  { href: '/', label: 'Buyer agent' },
  { href: '/recipe', label: 'Recipe order' },
  { href: '/approvals', label: 'Approvals' },
  { href: '/exposure', label: 'What agents see' },
  { href: '/audit', label: 'Decision record' },
  { href: '/stats', label: 'Buyer stats' },
  { href: '/models', label: 'Models' },
  { href: '/verify', label: 'Verify' },
];

/** Aimo-style header: a petrol strip with a white tab on top, the logo and uppercase condensed links below. The Approvals link shows how many orders are waiting. */
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
    <header className="sticky top-0 z-30 shrink-0 bg-white">
      <div className="h-[30px] bg-primary" aria-hidden="true" />
      <div className="border-b px-4 py-3 md:px-8">
        <div className="mx-auto flex max-w-[90rem] flex-col gap-2 md:flex-row md:items-center md:gap-8">
        <Link href="/" className="shrink-0">
          <Image src="/valio-aimo.png" alt="Valio Aimo" width={389} height={129} priority className="h-10 w-auto md:h-12" />
        </Link>
        <nav aria-label="Main" className="-mx-1 flex gap-5 overflow-x-auto md:mx-0 md:flex-wrap md:gap-x-4 md:gap-y-0 md:overflow-visible xl:gap-x-6">
          {LINKS.map((l) => {
            const active = pathname === l.href;
            return (
              <Link
                key={l.href}
                href={l.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex min-h-11 shrink-0 items-center gap-2 border-b-4 border-transparent px-1 font-heading text-[1.25rem] leading-none font-bold whitespace-nowrap text-primary uppercase transition-colors md:text-[1.125rem] xl:text-[1.375rem]',
                  active ? 'border-lime' : 'hover:border-petrol-30'
                )}
              >
                {l.label}
                {l.href === '/approvals' && waiting > 0 && (
                  <span className="inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-[3px] bg-warn-soft px-1.5 font-sans text-xs font-semibold text-warn">
                    {waiting}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
        </div>
      </div>
    </header>
  );
}
