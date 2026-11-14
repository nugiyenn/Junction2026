import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chInsertOrders, chQuery, chStats, STATS_SQL } from '../src/lib/clickhouse.ts';
import { kafkaConfigured, parseCa, publishAuditEvent, saslMechanism, toTradeEvent } from '../src/lib/events.ts';
import { buildStats, fillWeeks, getBuyerStats, loadStatsOrders, quantile, weekStart, type Queryable } from '../src/lib/stats.ts';
import type { AuditEvent, StatsOrder } from '../src/types/index.ts';

const order = (id: string, at: string, outcome: StatsOrder['outcome'], total: number, over: Partial<StatsOrder> = {}): StatsOrder => ({
  id,
  at,
  mandateId: 'demo-hotel',
  outcome,
  synthetic: false,
  total,
  decisionSeconds: null,
  avgCo2: null,
  avgReliability: null,
  lines: [{ productId: 'A', name: 'Milk', total }],
  ...over,
});

// 2026-11-02 is a Monday.
const ORDERS: StatsOrder[] = [
  order('1', '2026-11-02T08:00:00.000Z', 'auto_approved', 100, { synthetic: true, avgCo2: 2, avgReliability: 0.9 }),
  order('2', '2026-11-08T23:59:00.000Z', 'approved', 300, { synthetic: true, decisionSeconds: 600, avgCo2: 4, avgReliability: 0.8, lines: [{ productId: 'B', name: 'Cheese', total: 300 }] }),
  order('3', '2026-11-17T10:00:00.000Z', 'declined', 400, { decisionSeconds: 1800 }),
  order('4', '2026-11-18T10:00:00.000Z', 'rejected', 1000),
  order('5', '2026-11-18T11:00:00.000Z', 'pending', 200),
];

describe('buildStats', () => {
  const s = buildStats(ORDERS);

  it('counts orders by outcome and separates real from synthetic', () => {
    assert.deepEqual(s.outcomes, { auto_approved: 1, approved: 1, declined: 1, rejected: 1, pending: 1 });
    assert.deepEqual(s.totals, { orders: 5, realOrders: 3, syntheticOrders: 2, confirmedSpend: 400 });
  });

  it('buckets confirmed spend by Monday-start week, filling empty weeks', () => {
    assert.deepEqual(s.weeks, [
      { week: '2026-11-02', spend: 400, syntheticSpend: 400, orders: 2 },
      { week: '2026-11-09', spend: 0, syntheticSpend: 0, orders: 0 },
      { week: '2026-11-16', spend: 0, syntheticSpend: 0, orders: 3 },
    ]);
  });

  it('averages decision time, carbon and reliability over the orders that have a value', () => {
    assert.equal(s.avgDecisionSeconds, 1200);
    assert.equal(s.avgCo2PerKg, 3);
    assert.ok(Math.abs((s.avgReliability ?? 0) - 0.85) < 1e-9);
  });

  it('gives median and 90th percentile of order size by linear interpolation', () => {
    assert.deepEqual(s.orderSize, { median: 300, p90: 760 });
  });

  it('ranks top products by confirmed spend only', () => {
    assert.deepEqual(s.topProducts, [
      { productId: 'B', name: 'Cheese', spend: 300, orders: 1 },
      { productId: 'A', name: 'Milk', spend: 100, orders: 1 },
    ]);
  });

  it('handles no orders', () => {
    const e = buildStats([]);
    assert.equal(e.orderSize, null);
    assert.equal(e.avgDecisionSeconds, null);
    assert.deepEqual(e.weeks, []);
  });
});

describe('helpers', () => {
  it('quantile interpolates between ranks', () => {
    assert.equal(quantile([10], 0.9), 10);
    assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  });
  it('weekStart is the Monday, in UTC', () => {
    assert.equal(weekStart('2026-11-08T23:59:59.000Z'), '2026-11-02');
    assert.equal(weekStart('2026-11-09T00:00:00.000Z'), '2026-11-09');
  });
  it('fillWeeks leaves a single week alone', () => {
    const w = [{ week: '2026-11-02', spend: 1, syntheticSpend: 0, orders: 1 }];
    assert.deepEqual(fillWeeks(w), w);
  });
});

describe('loadStatsOrders', () => {
  it('maps real orders to outcomes and takes carbon and reliability from the catalog', async () => {
    const created = new Date('2026-11-02T08:00:00.000Z');
    const decided = new Date('2026-11-02T08:10:00.000Z');
    const line = (id: string) => [{ productId: id, name: id, total: 50 }];
    const row = (id: string, status: string, decided_by: string | null, decided_at: Date | null, lines = line('P1')) => ({
      id, mandate_id: 'demo-hotel', status, total: 50, created_at: created, decided_by, decided_at, lines,
    });
    const db: Queryable = {
      async query(text) {
        if (text.includes('FROM orders')) {
          return {
            rows: [
              row('a', 'confirmed', null, null),
              row('b', 'confirmed', 'Manager', decided),
              row('c', 'rejected', 'Manager', decided),
              row('d', 'rejected', null, null),
              row('e', 'pending_approval', null, null, [...line('P1'), ...line('P2')]),
            ],
          };
        }
        if (text.includes('FROM products')) return { rows: [{ id: 'P1', co2_per_kg: 2, delivery_reliability: 0.9 }, { id: 'P2', co2_per_kg: 4, delivery_reliability: null }] };
        return { rows: [] };
      },
    };
    const out = await loadStatsOrders(db, 'demo-hotel');
    assert.deepEqual(out.map((o) => o.outcome), ['auto_approved', 'approved', 'declined', 'rejected', 'pending']);
    assert.equal(out[1].decisionSeconds, 600);
    assert.equal(out[4].avgCo2, 3);
    assert.equal(out[4].avgReliability, 0.9);
    assert.ok(out.every((o) => !o.synthetic));
  });
});

const audit: AuditEvent = {
  id: '12',
  at: '2026-11-14T10:00:00.000Z',
  actor: 'system',
  action: 'order_confirmed',
  mandateId: 'demo-hotel',
  quoteId: 'q',
  orderId: 'o',
  summary: 'Order for 12.00 EUR ex VAT confirmed automatically',
  data: { outcome: 'auto_approve', reasons: ['secret price reason'], listPrice: 9 },
  hash: 'abc',
  prevHash: 'prev',
};

describe('Kafka events', () => {
  it('publishes only whitelisted fields: no summary, no data', () => {
    const e = toTradeEvent(audit);
    assert.deepEqual(Object.keys(e).sort(), ['action', 'actor', 'at', 'hash', 'id', 'mandateId', 'orderId', 'quoteId']);
    const text = JSON.stringify(e);
    assert.ok(!text.includes('secret') && !text.includes('EUR') && !text.includes('prev'));
  });

  it('sends the event through the injected sender', async () => {
    const sent: unknown[] = [];
    const ok = await publishAuditEvent(audit, { configured: true, send: async (e) => void sent.push(e) });
    assert.equal(ok, true);
    assert.deepEqual(sent, [toTradeEvent(audit)]);
  });

  it('does not throw when the producer fails', async () => {
    const ok = await publishAuditEvent(audit, {
      configured: true,
      send: async () => {
        throw new Error('broker down');
      },
    });
    assert.equal(ok, false);
  });

  it('gives up after the timeout instead of waiting', async () => {
    const started = Date.now();
    const ok = await publishAuditEvent(audit, { configured: true, timeoutMs: 20, send: () => new Promise(() => undefined) });
    assert.equal(ok, false);
    assert.ok(Date.now() - started < 1000);
  });

  it('does nothing when Kafka is not configured', async () => {
    let called = false;
    const ok = await publishAuditEvent(audit, { configured: false, send: async () => void (called = true) });
    assert.equal(ok, false);
    assert.equal(called, false);
  });

  it('reads the config: SASL needs brokers, CA, user and password', () => {
    assert.equal(kafkaConfigured({}), false);
    assert.equal(kafkaConfigured({ AIVEN_KAFKA_BROKERS: 'h:1', AIVEN_KAFKA_CA: 'x', AIVEN_KAFKA_USERNAME: 'u' }), false);
    assert.equal(kafkaConfigured({ AIVEN_KAFKA_BROKERS: 'h:1', AIVEN_KAFKA_CA: 'x', AIVEN_KAFKA_USERNAME: 'u', AIVEN_KAFKA_PASSWORD: 'p' }), true);
  });

  it('accepts the CA as PEM, one line with \\n escapes, or base64, and defaults the mechanism', () => {
    const pem = '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----';
    assert.equal(parseCa(pem), pem);
    assert.equal(parseCa(pem.replaceAll('\n', '\\n')), pem);
    assert.equal(parseCa(Buffer.from(pem).toString('base64')), pem);
    assert.equal(saslMechanism({}), 'scram-sha-256');
    assert.equal(saslMechanism({ AIVEN_KAFKA_SASL_MECHANISM: 'PLAIN' }), 'plain');
    assert.throws(() => saslMechanism({ AIVEN_KAFKA_SASL_MECHANISM: 'gssapi' }));
  });
});

/** A fetch fake: records requests and answers by a matcher on the SQL. */
function fakeFetch(answer: (sql: string) => { status?: number; data?: unknown[] }) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fn = (async (url: URL, init: RequestInit) => {
    calls.push({ url, init });
    const a = answer(String(init.body));
    return new Response(a.status && a.status !== 200 ? 'Code: 60. DB::Exception: Unknown table' : JSON.stringify({ data: a.data ?? [] }), { status: a.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('ClickHouse', () => {
  const url = 'https://avnadmin:p%40ss@ch.example.com:443';

  it('moves credentials to a Basic header and values into query parameters, never into the SQL', async () => {
    const f = fakeFetch(() => ({ data: [] }));
    await chQuery('SELECT 1 WHERE m = {mandate:String}', { mandate: "x' OR 1=1 --" }, { fetch: f.fn, url });
    const { url: u, init } = f.calls[0];
    assert.equal(u.username, '');
    assert.equal(u.password, '');
    assert.equal(u.searchParams.get('database'), 'default');
    assert.equal(init.method, 'POST');
    assert.ok(String(init.body).endsWith('FORMAT JSON'));
    assert.equal(u.searchParams.get('param_mandate'), "x' OR 1=1 --");
    assert.equal((init.headers as Record<string, string>).Authorization, `Basic ${Buffer.from('avnadmin:p@ss').toString('base64')}`);
    assert.ok(!String(init.body).includes('OR 1=1'));
  });

  it('throws a readable error on a non-200 answer', async () => {
    const f = fakeFetch(() => ({ status: 404 }));
    await assert.rejects(chQuery('SELECT 1', {}, { fetch: f.fn, url }), /ClickHouse answered 404: Code: 60/);
  });

  it('refuses to run without a URL', async () => {
    const saved = process.env.AIVEN_CLICKHOUSE_URL;
    delete process.env.AIVEN_CLICKHOUSE_URL;
    await assert.rejects(chQuery('SELECT 1'), /Missing AIVEN_CLICKHOUSE_URL: cannot query clickhouse/);
    if (saved) process.env.AIVEN_CLICKHOUSE_URL = saved;
  });

  it('assembles the stats from the four-query answers', async () => {
    const f = fakeFetch((sql) => {
      if (sql === `${STATS_SQL.summary}\nFORMAT JSON`)
        return { data: [{ orders: 5, real_orders: 3, synthetic_orders: 2, confirmed_spend: 400, avg_decision: 1200, avg_co2: null, avg_reliability: 0.85, median: 300, p90: 760 }] };
      if (sql.includes('GROUP BY outcome')) return { data: [{ outcome: 'approved', n: 2 }] };
      if (sql.includes('toStartOfWeek')) return { data: [{ week: '2026-11-02', spend: 400, synthetic_spend: 400, orders: 2 }] };
      return { data: [{ product_id: 'B', name: 'Cheese', spend: 300, orders: 1 }] };
    });
    const s = await chStats('demo-hotel', { fetch: f.fn, url });
    assert.equal(f.calls.length, 4);
    assert.equal(s.outcomes.approved, 2);
    assert.equal(s.outcomes.pending, 0);
    assert.equal(s.avgCo2PerKg, null);
    assert.deepEqual(s.orderSize, { median: 300, p90: 760 });
    assert.deepEqual(s.topProducts, [{ productId: 'B', name: 'Cheese', spend: 300, orders: 1 }]);
    assert.ok(f.calls.every((c) => c.url.searchParams.get('param_mandate') === 'demo-hotel'));
  });

  it('loads orders as JSONEachRow', async () => {
    const f = fakeFetch(() => ({}));
    await chInsertOrders([ORDERS[0]], { fetch: f.fn, url });
    assert.equal(f.calls[0].url.searchParams.get('query'), 'INSERT INTO orders_fact FORMAT JSONEachRow');
    const row = JSON.parse(String(f.calls[0].init.body));
    assert.equal(row.synthetic, 1);
    assert.deepEqual(row.line_product_ids, ['A']);
  });
});

describe('getBuyerStats', () => {
  const db: Queryable = { query: async () => ({ rows: [] }) };

  it('answers from Postgres and shows ClickHouse as not configured', async () => {
    const s = await getBuyerStats('demo-hotel', 'Hotel', { db, clickhouse: { configured: false } });
    assert.equal(s.source, 'postgres');
    const ch = s.infra.find((i) => i.name === 'clickhouse');
    assert.deepEqual([ch?.configured, ch?.ok], [false, null]);
  });

  it('falls back to Postgres visibly when ClickHouse fails', async () => {
    const f = fakeFetch(() => ({ status: 500 }));
    const s = await getBuyerStats('demo-hotel', 'Hotel', { db, clickhouse: { configured: true, fetch: f.fn, url: 'https://h:1' } });
    assert.equal(s.source, 'postgres');
    const ch = s.infra.find((i) => i.name === 'clickhouse');
    assert.equal(ch?.ok, false);
    assert.match(ch?.detail ?? '', /ClickHouse answered 500/);
  });

  it('answers from ClickHouse when it works', async () => {
    const f = fakeFetch((sql) => ({ data: sql.includes('trade_events') ? [{ action: 'order_confirmed', n: 3, latest: '2026-11-14 10:00:00.000' }] : [] }));
    const s = await getBuyerStats('demo-hotel', 'Hotel', { db, clickhouse: { configured: true, fetch: f.fn, url: 'https://h:1' } });
    assert.equal(s.source, 'clickhouse');
    assert.equal(s.stream?.events, 3);
    assert.equal(s.stream?.latestAt, '2026-11-14T10:00:00.000Z');
    assert.equal(s.infra.find((i) => i.name === 'clickhouse')?.ok, true);
  });
});
