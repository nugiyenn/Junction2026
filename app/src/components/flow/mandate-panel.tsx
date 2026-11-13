'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { Mandate } from '@/types';
import { allergenName, call } from './api';

const COMMON_ALLERGENS = ['AM', 'AE', 'AF', 'AN', 'AP', 'AS', 'AY', 'AW'];

/** The buyer's side: what the agent may decide alone. Edits take effect on the next order. */
export function MandatePanel({
  mandate,
  onSaved,
  onError,
}: {
  mandate: Mandate;
  onSaved: (m: Mandate) => void;
  onError: (message: string) => void;
}) {
  const [auto, setAuto] = useState(String(mandate.autoApproveLimitEur));
  const [max, setMax] = useState(String(mandate.maxOrderEur));
  const [reliability, setReliability] = useState(
    mandate.minDeliveryReliability === null ? '' : String(Math.round(mandate.minDeliveryReliability * 100))
  );
  const [confirmedStock, setConfirmedStock] = useState(mandate.requireConfirmedStock);
  const [allergens, setAllergens] = useState<string[]>(mandate.blockedAllergens);
  const [saving, setSaving] = useState(false);

  const toggle = (code: string) =>
    setAllergens((a) => (a.includes(code) ? a.filter((c) => c !== code) : [...a, code]));
  const shown = [...new Set([...COMMON_ALLERGENS, ...allergens])];

  async function save() {
    setSaving(true);
    try {
      const { mandate: saved } = await call<{ mandate: Mandate }>(
        `/api/mandates/${mandate.id}`,
        {
          changedBy: `${mandate.buyerName} admin`,
          autoApproveLimitEur: Number(auto),
          maxOrderEur: Number(max),
          blockedAllergens: allergens,
          minDeliveryReliability: reliability.trim() === '' ? null : Number(reliability) / 100,
          requireConfirmedStock: confirmedStock,
        },
        'PATCH'
      );
      onSaved(saved);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Agent decides alone up to (€, ex VAT)</span>
          <Input type="number" min={0} value={auto} onChange={(e) => setAuto(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Rejected above (€)</span>
          <Input type="number" min={0} value={max} onChange={(e) => setMax(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Human check below delivery reliability (%)</span>
          <Input
            type="number"
            min={0}
            max={100}
            placeholder="no rule"
            value={reliability}
            onChange={(e) => setReliability(e.target.value)}
          />
        </label>
      </div>

      <label className="flex items-center gap-2">
        <input type="checkbox" checked={confirmedStock} onChange={(e) => setConfirmedStock(e.target.checked)} />
        Human check when stock is unconfirmed (supplier ships it, quantity unknown)
      </label>

      <div className="flex flex-col gap-1">
        <span className="text-muted-foreground">Blocked allergens: contained = rejected, may contain = human check</span>
        <div className="flex flex-wrap gap-2">
          {shown.map((code) => (
            <button
              key={code}
              type="button"
              onClick={() => toggle(code)}
              className={`rounded-full border px-2.5 py-0.5 text-xs ${
                allergens.includes(code) ? 'border-destructive bg-destructive/10 text-destructive' : 'text-muted-foreground'
              }`}
            >
              {allergenName(code)}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={saving} className="self-start">
          {saving ? 'Saving…' : 'Save mandate'}
        </Button>
        <span className="text-xs text-muted-foreground">Every change is written to the decision record.</span>
      </div>
    </div>
  );
}
