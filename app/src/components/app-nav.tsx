'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from 'cn';

const LINKS = [
  { href: '/', label: 'Buyer agent' },
  { href: '/approvals', label: 'Approvals' },
  { href: '/exposure', label: 'What agents see' },
  { href: '/audit', label: 'Decision record' },
];

export function AppNav() {
  const pathname = usePathname();
  return (
    <header className="border-b bg-background">
      <nav className="mx-auto flex w-full max-w-5xl items-center gap-6 px-4 py-3 text-sm">
        <span className="font-semibold">Trusted Trade Gateway</span>
        <span className="text-muted-foreground">Valio Aimo</span>
        <div className="ml-auto flex gap-4">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={cn('hover:text-foreground', pathname === l.href ? 'font-medium text-foreground' : 'text-muted-foreground')}
            >
              {l.label}
            </Link>
          ))}
        </div>
      </nav>
    </header>
  );
}
