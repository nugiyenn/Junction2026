import 'server-only';
import { eventHash, verifyChain, type ChainRow, type ChainStatus } from '@/lib/chain';
import { getPool } from '@/lib/db';
import type { AuditEvent } from '@/types';

/** Serialises writers, so two events cannot both extend the same previous hash and fork the chain. */
const AUDIT_LOCK = 7731001;

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
  prev_hash: string | null;
  hash: string | null;
}

const toEvent = (r: AuditRow): AuditEvent => ({
  id: r.id,
  at: r.at.toISOString(),
  actor: r.actor,
  action: r.action,
  mandateId: r.mandate_id,
  quoteId: r.quote_id,
  orderId: r.order_id,
  summary: r.summary,
  data: r.data,
  prevHash: r.prev_hash,
  hash: r.hash,
});

/**
 * Appends an event to the audit trail. Each event stores a hash covering the previous event's hash and its own
 * content (see chain.ts), so the trail cannot be edited afterwards without `verifyAuditChain` noticing.
 */
export async function logAudit(event: Omit<AuditEvent, 'id' | 'at' | 'hash' | 'prevHash'>): Promise<void> {
  // Millisecond precision, set here rather than by the database, so the hashed value is exactly what is read back.
  const at = new Date();
  const data = JSON.parse(JSON.stringify(event.data));

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [AUDIT_LOCK]);
    const { rows: last } = await client.query<{ hash: string | null }>('SELECT hash FROM audit_events ORDER BY id DESC LIMIT 1');
    const prevHash = last[0]?.hash ?? null;
    const hash = eventHash(prevHash, {
      at: at.toISOString(),
      actor: event.actor,
      action: event.action,
      mandateId: event.mandateId,
      quoteId: event.quoteId,
      orderId: event.orderId,
      summary: event.summary,
      data,
    });
    await client.query(
      `INSERT INTO audit_events (at, actor, action, mandate_id, quote_id, order_id, summary, data, prev_hash, hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [at, event.actor, event.action, event.mandateId, event.quoteId, event.orderId, event.summary, JSON.stringify(data), prevHash, hash]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
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
  return rows.map(toEvent);
}

/** Re-computes every hash from the first event on. The whole trail is read, not a filtered view of it. */
export async function verifyAuditChain(): Promise<ChainStatus> {
  const { rows } = await getPool().query<AuditRow>('SELECT * FROM audit_events ORDER BY id ASC');
  const chain: ChainRow[] = rows.map((r) => ({
    id: r.id,
    at: r.at.toISOString(),
    actor: r.actor,
    action: r.action,
    mandateId: r.mandate_id,
    quoteId: r.quote_id,
    orderId: r.order_id,
    summary: r.summary,
    data: r.data,
    prevHash: r.prev_hash,
    hash: r.hash,
  }));
  return verifyChain(chain);
}
