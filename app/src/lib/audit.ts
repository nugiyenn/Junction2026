import 'server-only';
import { getPool } from '@/lib/db';
import type { AuditEvent } from '@/types';

interface AuditRow {
  id: string;
  at: Date;
  actor: AuditEvent['actor'];
  action: AuditEvent['action'];
  mandate_id: string | null;
  quote_id: string | null;
  order_id: string | null;
  summary: string;
  data: Record<string, unknown>;
}

export async function logAudit(event: Omit<AuditEvent, 'id' | 'at'>): Promise<void> {
  await getPool().query(
    `INSERT INTO audit_events (actor, action, mandate_id, quote_id, order_id, summary, data)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [event.actor, event.action, event.mandateId, event.quoteId, event.orderId, event.summary, JSON.stringify(event.data)]
  );
}

/** Newest first. With `orderId`, also returns the events of the quote that order came from. */
export async function listAudit(filter: { orderId?: string; mandateId?: string }, limit = 100): Promise<AuditEvent[]> {
  const { rows } = await getPool().query<AuditRow>(
    `SELECT * FROM audit_events
     WHERE ($1::uuid IS NULL OR order_id = $1 OR quote_id = (SELECT quote_id FROM orders WHERE id = $1))
       AND ($2::text IS NULL OR mandate_id = $2)
     ORDER BY id DESC LIMIT $3`,
    [filter.orderId ?? null, filter.mandateId ?? null, limit]
  );
  return rows.map((r) => ({
    id: r.id,
    at: r.at.toISOString(),
    actor: r.actor,
    action: r.action,
    mandateId: r.mandate_id,
    quoteId: r.quote_id,
    orderId: r.order_id,
    summary: r.summary,
    data: r.data,
  }));
}
