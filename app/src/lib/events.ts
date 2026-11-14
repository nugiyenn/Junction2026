import 'server-only';
import type { SASLOptions } from 'kafkajs';
import type { AuditEvent, InfraStatus } from '../types/index.ts';

// Publishes decision events to Aiven for Apache Kafka. Aiven's Kafka-to-ClickHouse integration ingests the topic
// (scripts/aiven-setup.md). Publishing is best effort: it must never block or fail an order or an audit write.

/** The only fields that leave the gateway. No summary text (free text) and no `data` (prices, reasons). */
export interface TradeEvent {
  id: string;
  at: string;
  actor: string;
  action: string;
  mandateId: string | null;
  quoteId: string | null;
  orderId: string | null;
  hash: string | null;
}

/** Copies the whitelisted fields only, so a field added to AuditEvent later is not published by accident. */
export function toTradeEvent(e: AuditEvent): TradeEvent {
  return {
    id: e.id,
    at: e.at,
    actor: e.actor,
    action: e.action,
    mandateId: e.mandateId,
    quoteId: e.quoteId,
    orderId: e.orderId,
    hash: e.hash,
  };
}

export const KAFKA_TIMEOUT_MS = 4000;

export const kafkaTopic = () => 'trade-events';

const MECHANISMS = ['scram-sha-256', 'scram-sha-512', 'plain'] as const;
type Mechanism = (typeof MECHANISMS)[number];

/** Aiven's CA certificate: PEM text, PEM on one line with literal \n escapes, or base64 of the PEM. */
export function parseCa(value: string): string {
  const v = value.trim();
  return v.includes('-----BEGIN') ? v.replace(/\\n/g, '\n') : Buffer.from(v, 'base64').toString('utf8');
}

export function saslMechanism(env: Record<string, string | undefined> = process.env): Mechanism {
  const m = (env.AIVEN_KAFKA_SASL_MECHANISM || 'scram-sha-256').toLowerCase();
  if (!(MECHANISMS as readonly string[]).includes(m)) throw new Error(`AIVEN_KAFKA_SASL_MECHANISM must be one of ${MECHANISMS.join(', ')}, not ${m}`);
  return m as Mechanism;
}

/** Brokers, the CA certificate and a SASL user and password. */
export function kafkaConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return !!env.AIVEN_KAFKA_BROKERS && !!env.AIVEN_KAFKA_CA && !!env.AIVEN_KAFKA_USERNAME && !!env.AIVEN_KAFKA_PASSWORD;
}

type Send = (event: TradeEvent) => Promise<void>;

/** One short-lived producer per call: connect, send, disconnect. Nothing stays open between serverless invocations. */
const sendWithKafkaJs: Send = async (event) => {
  const env = process.env;
  if (!env.AIVEN_KAFKA_BROKERS) throw new Error('Missing AIVEN_KAFKA_BROKERS: cannot publish events');
  const { Kafka, logLevel } = await import('kafkajs');
  const kafka = new Kafka({
    clientId: 'trusted-trade-gateway',
    brokers: env.AIVEN_KAFKA_BROKERS.split(',').map((b) => b.trim()),
    ssl: { ca: [parseCa(env.AIVEN_KAFKA_CA ?? '')] },
    sasl: { mechanism: saslMechanism(env), username: env.AIVEN_KAFKA_USERNAME ?? '', password: env.AIVEN_KAFKA_PASSWORD ?? '' } as SASLOptions,
    connectionTimeout: 2000,
    requestTimeout: 3000,
    retry: { retries: 1 },
    logLevel: logLevel.NOTHING,
  });
  const producer = kafka.producer({ allowAutoTopicCreation: false });
  await producer.connect();
  try {
    // Keyed by buyer so one buyer's events stay in order within a partition.
    await producer.send({
      topic: kafkaTopic(),
      messages: [{ key: event.mandateId ?? 'none', value: JSON.stringify(event) }],
      timeout: 3000,
    });
  } finally {
    await producer.disconnect().catch(() => undefined);
  }
};

/** What happened to the most recent publish in this server instance. Shown on the stats page. */
let last: { ok: boolean; at: string; detail: string } | null = null;

/**
 * Publishes one event. Never throws and never waits longer than the timeout: failures are logged and
 * remembered for `kafkaStatus`. Does nothing when Kafka is not configured.
 */
export async function publishAuditEvent(
  event: AuditEvent,
  deps: { send?: Send; timeoutMs?: number; configured?: boolean } = {}
): Promise<boolean> {
  if (!(deps.configured ?? kafkaConfigured())) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timed out')), deps.timeoutMs ?? KAFKA_TIMEOUT_MS);
    });
    await Promise.race([(deps.send ?? sendWithKafkaJs)(toTradeEvent(event)), timeout]);
    last = { ok: true, at: new Date().toISOString(), detail: `published event ${event.id}` };
    return true;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`Kafka publish failed: ${detail}`);
    last = { ok: false, at: new Date().toISOString(), detail };
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Kafka as the stats page shows it. `ok` is null until this server instance has tried a publish. */
export function kafkaStatus(): InfraStatus {
  if (!kafkaConfigured()) {
    return { name: 'kafka', configured: false, ok: null, detail: 'Not configured: set AIVEN_KAFKA_BROKERS, _USERNAME, _PASSWORD and _CA. Decision events are not published.' };
  }
  const topic = kafkaTopic();
  if (!last) return { name: 'kafka', configured: true, ok: null, detail: `Topic ${topic}. No publish attempted yet by this server instance.` };
  return { name: 'kafka', configured: true, ok: last.ok, detail: `Topic ${topic}. Last publish ${last.ok ? 'succeeded' : `failed: ${last.detail}`} at ${last.at}.` };
}
