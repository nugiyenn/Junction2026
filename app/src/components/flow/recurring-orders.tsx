'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Pill, type Tone } from '@/components/page';
import type { ExposedOrder, ExposedQuote } from '@/types';
import { call, eur } from './api';

/** What an agent is told when an order differs from the buyer's usual ones. The same sentence as DEVIATION_REASON in lib/deviation.ts. */
const UNUSUAL_REASON = "Needs approval: differs from this buyer's usual orders.";

const MANDATE = 'demo-hotel';

/**
 * Real orders on the hotel's mandate, placed as its agent would: a quote, then an order with an Idempotency-Key.
 * The hotel has ordered 1,000 L of Valio skimmed milk 1 l every Monday for 26 weeks (scripts/seed-standing-orders.mts).
 * The whole milk is Valio whole milk 1 l, lactose free UHT: a whole milk the mock can quote today.
 */
const SCENARIOS = [
  { key: 'usual', label: 'Weekly milk, as usual', productId: '469477', quantity: 1000, hint: '1,000 L skimmed milk' },
  { key: 'swapped', label: 'Weekly milk, swapped to whole milk', productId: '464073', quantity: 1000, hint: '1,000 L whole milk' },
  { key: 'ten', label: 'Weekly milk, 10x quantity', productId: '469477', quantity: 10000, hint: '10,000 L skimmed milk' },
  { key: 'holiday', label: 'Holiday week, +20%', productId: '469477', quantity: 1200, hint: '1,200 L skimmed milk' },
] as const;

type Scenario = (typeof SCENARIOS)[number];

interface Outcome {
  tone: Tone;
  text: string;
  orderId: string;
}

/** The next Monday after today, as YYYY-MM-DD in local time: the hotel's usual delivery day. */
function nextMonday(from = new Date()): string {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  d.setDate(d.getDate() + (((8 - d.getDay()) % 7) || 7));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** One plain line about an order, in the words the agent itself would be given. */
function describe(order: ExposedOrder): Outcome {
  const unusual = order.policyReasons.includes(UNUSUAL_REASON);
  const others = order.policyReasons.filter((r) => r !== UNUSUAL_REASON);
  const amount = `${eur(order.total)} ex VAT`;
  if (order.status === 'confirmed') {
    return { tone: 'ok', orderId: order.id, text: `Confirmed automatically for ${amount}. Not flagged as unusual.` };
  }
  if (order.status === 'rejected') {
    return {
      tone: 'bad',
      orderId: order.id,
      text: `Rejected by the mandate for ${amount}. ${unusual ? 'Also flagged: it differs from this buyer’s usual orders. ' : 'Not flagged as unusual. '}${others.join(' ')}`.trim(),
    };
  }
  if (unusual) {
    return {
      tone: 'warn',
      orderId: order.id,
      text: `Flagged and waiting for approval (${amount}): it differs from this buyer’s usual orders. ${others.length ? `Also: ${others.join(' ')}` : ''}`.trim(),
    };
  }
  // Held, but not for being unusual: the total limit or the rolling 24 hour rule did it.
  return {
    tone: 'plain',
    orderId: order.id,
    text: `Not flagged as unusual, but waiting for approval (${amount}) for another reason: ${others.join(' ')}`.trim(),
  };
}

export function RecurringOrders({ disabled }: { disabled: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, Outcome | { error: string }>>({});

  async function place(s: Scenario) {
    setBusy(s.key);
    try {
      const { quote } = await call<{ quote: ExposedQuote }>('/api/quotes', {
        mandateId: MANDATE,
        deliveryDate: nextMonday(),
        lines: [{ productId: s.productId, quantity: s.quantity }],
      });
      // As an agent would: one Idempotency-Key per order, so a retry cannot place it twice.
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `recurring-${s.key}-${crypto.randomUUID()}` },
        body: JSON.stringify({ quoteId: quote.id }),
      });
      const json = (await res.json()) as { order?: ExposedOrder; error?: string };
      if (!res.ok || !json.order) throw new Error(json.error ?? `HTTP ${res.status}`);
      setResults((r) => ({ ...r, [s.key]: describe(json.order!) }));
    } catch (err) {
      setResults((r) => ({ ...r, [s.key]: { error: err instanceof Error ? err.message : String(err) } }));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-label="Recurring orders" className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-1 text-xs font-medium text-muted-foreground">Recurring orders</span>
        {SCENARIOS.map((s) => (
          <Button key={s.key} variant="outline" className="h-11 px-4" title={s.hint} disabled={disabled || busy !== null} onClick={() => place(s)}>
            {busy === s.key ? 'Placing…' : s.label}
          </Button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Places a real order for Nordic Hotel Group&apos;s agent, which has ordered 1,000 L of skimmed milk every Monday. The total limit can hold even the
        usual order for approval; the unusual-order check is separate and is explained in each result.
      </p>
      {SCENARIOS.filter((s) => results[s.key]).map((s) => {
        const r = results[s.key];
        return (
          <p key={s.key} className="flex flex-wrap items-start gap-x-2.5 gap-y-1.5 text-[13px]">
            {'error' in r ? <Pill tone="bad">Failed</Pill> : <Pill tone={r.tone}>{s.label}</Pill>}
            <span className="min-w-0 flex-1 break-words">{'error' in r ? r.error : r.text}</span>
            {'orderId' in r && (
              <Link href="/approvals" className="text-primary underline">
                Open approvals
              </Link>
            )}
          </p>
        );
      })}
    </section>
  );
}
