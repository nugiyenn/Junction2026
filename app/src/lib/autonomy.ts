import 'server-only';
import { pickSuggestion } from '@/lib/autonomy-accept';
import { historyNote, suggestAutonomy } from '@/lib/autonomy-core';
import { getPool } from '@/lib/db';
import { getMandate, updateMandate } from '@/lib/purchasing';
import { loadStatsOrders } from '@/lib/stats';
import type { AutonomyAcceptResponse, AutonomyResponse } from '@/types';

/** When the auto-approve limit was last changed (by a person, or an accepted suggestion). Earlier decisions were made under another limit. */
async function lastLimitChange(mandateId: string): Promise<string | null> {
  const { rows } = await getPool().query(
    `SELECT at FROM audit_events WHERE mandate_id = $1 AND action = 'mandate_changed' AND data->'after' ? 'autoApproveLimitEur'
     ORDER BY id DESC LIMIT 1`,
    [mandateId]
  );
  return rows[0] ? new Date(rows[0].at as string).toISOString() : null;
}

/** The buyer's suggestions: real orders plus labelled synthetic history, run through the pure rules. */
export async function getAutonomy(mandateId: string): Promise<AutonomyResponse> {
  const mandate = await getMandate(mandateId); // 404 for an unknown buyer
  const [orders, since] = await Promise.all([loadStatsOrders(getPool(), mandateId), lastLimitChange(mandateId)]);
  const result = suggestAutonomy({ mandateId, autoApproveLimitEur: mandate.autoApproveLimitEur, maxOrderEur: mandate.maxOrderEur, orders, now: new Date().toISOString(), since });
  return { mandate, ...result, note: historyNote(orders), evidenceSince: since };
}

/** Recomputes, refuses (409) when the id is stale, and applies through `updateMandate`, which writes the audit event. */
export async function acceptSuggestion(mandateId: string, suggestionId: string, decidedBy: string): Promise<AutonomyAcceptResponse> {
  const suggestion = pickSuggestion((await getAutonomy(mandateId)).suggestions, suggestionId);
  const mandate = await updateMandate(mandateId, { autoApproveLimitEur: suggestion.to }, `${decidedBy} (accepted earned-autonomy suggestion ${suggestion.id})`);
  return { mandate, suggestion };
}
