import 'server-only';
import { getPool } from '@/lib/db';
import { lineAmount } from '@/lib/deviation';
import type { DeviationHistoryLine, DeviationHistoryOrder, DeviationReport, QuoteLine } from '@/types';

/** How many past orders of one buyer are read for the baseline. The check itself looks at the last 12 weeks of them. */
const HISTORY_LIMIT = 300;

interface StoredLine {
  productId: string;
  name: string;
  total?: number | null;
  /** Synthetic standing orders carry these (scripts/seed-standing-orders.mts). Older synthetic rows do not and are not used. */
  amount?: number;
  unit?: DeviationHistoryLine['unit'];
}

/**
 * The buyer's past orders for the unusual-order check: the synthetic standing orders in `order_history` plus the
 * mandate's confirmed real orders. A real order that was flagged and then approved is left out unless the approver
 * accepted it as the new normal. Orders still waiting, declined or rejected never count.
 */
export async function loadDeviationHistory(mandateId: string): Promise<DeviationHistoryOrder[]> {
  const pool = getPool();
  const [synthetic, real, marks] = await Promise.all([
    pool.query<{ id: string; created_at: Date; total: number; lines: StoredLine[] }>(
      `SELECT id, created_at, total, lines FROM order_history
       WHERE mandate_id = $1 AND outcome IN ('auto_approved', 'approved') AND jsonb_path_exists(lines, '$[*].amount')
       ORDER BY created_at DESC LIMIT $2`,
      [mandateId, HISTORY_LIMIT]
    ),
    pool.query<{ id: string; created_at: Date; delivery_date: string; total: number; lines: QuoteLine[] }>(
      `SELECT id, created_at, delivery_date, total, lines FROM orders
       WHERE mandate_id = $1 AND status = 'confirmed' ORDER BY created_at DESC LIMIT $2`,
      [mandateId, HISTORY_LIMIT]
    ),
    pool.query<{ action: string; order_id: string | null; reported_order: string | null; differing: number | null }>(
      `SELECT action, order_id::text AS order_id, data->>'orderId' AS reported_order, (data->'report'->>'differing')::int AS differing
       FROM audit_events WHERE mandate_id = $1 AND action IN ('deviation_report', 'order_accepted_as_normal')`,
      [mandateId]
    ),
  ]);

  const flagged = new Set(marks.rows.filter((r) => r.action === 'deviation_report' && (r.differing ?? 0) > 0).map((r) => r.reported_order));
  const accepted = new Set(marks.rows.filter((r) => r.action === 'order_accepted_as_normal').map((r) => r.order_id));

  const fromHistory = synthetic.rows.map(
    (r): DeviationHistoryOrder => ({
      id: r.id,
      at: r.created_at.toISOString(),
      // The delivery date of a synthetic order travels on its lines, because the table has no column for it.
      deliveryDate: (r.lines as (StoredLine & { deliveryDate?: string })[]).find((l) => l.deliveryDate)?.deliveryDate ?? null,
      total: r.total,
      lines: r.lines.filter((l) => typeof l.amount === 'number').map((l) => ({ productId: l.productId, name: l.name, amount: l.amount!, unit: l.unit ?? 'unit', total: l.total ?? null })),
    })
  );
  const fromOrders = real.rows.map(
    (r): DeviationHistoryOrder => ({
      id: r.id,
      at: r.created_at.toISOString(),
      deliveryDate: r.delivery_date,
      total: r.total,
      lines: r.lines.map((l) => ({ productId: l.productId, name: l.name, ...lineAmount(l), total: l.lineTotal })),
      flagged: flagged.has(r.id),
      acceptedAsNormal: accepted.has(r.id),
    })
  );
  return [...fromHistory, ...fromOrders];
}

/** The stored report for one order, or null when none was recorded (an order from before the check existed). */
export async function getDeviationReport(orderId: string): Promise<DeviationReport | null> {
  const { rows } = await getPool().query<{ report: DeviationReport }>(
    `SELECT data->'report' AS report FROM audit_events
     WHERE action = 'deviation_report' AND data->>'orderId' = $1 ORDER BY id DESC LIMIT 1`,
    [orderId]
  );
  return rows[0]?.report ?? null;
}
