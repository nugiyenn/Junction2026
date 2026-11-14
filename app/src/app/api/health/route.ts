import { approverKeyConfigured } from '@/lib/auth';
import { getPool } from '@/lib/db';
import { errorResponse } from '@/lib/http';
import { getKV, readCacheStats, valkeyConfigured } from '@/lib/cache';
import type { HealthReport, ServiceHealth } from '@/types';

async function probe(name: ServiceHealth['name'], configured: boolean, off: string, check: () => Promise<void>): Promise<ServiceHealth> {
  if (!configured) return { name, configured, ok: false, latencyMs: null, detail: off };
  const start = Date.now();
  try {
    await check();
    return { name, configured, ok: true, latencyMs: Date.now() - start, detail: 'Reachable.' };
  } catch (err) {
    return { name, configured, ok: false, latencyMs: Date.now() - start, detail: err instanceof Error ? err.message : 'Unreachable.' };
  }
}

/**
 * GET /api/health
 * Whether each backing service is configured and answering. Valkey is optional: when it is off,
 * caching, rate limiting and idempotency are off too and everything else keeps working.
 */
export async function GET() {
  try {
    const [postgres, valkey] = await Promise.all([
      probe('postgres', Boolean(process.env.AIVEN_DATABASE_URL), 'AIVEN_DATABASE_URL is not set: the gateway cannot work.', async () => {
        await getPool().query('SELECT 1');
      }),
      probe('valkey', valkeyConfigured(), 'AIVEN_VALKEY_URL is not set: caching, rate limiting and idempotency are off.', () => getKV().ping()),
    ]);
    let cache: HealthReport['cache'] = null;
    if (valkey.ok) {
      try {
        cache = await readCacheStats(getKV());
      } catch (err) {
        console.error('Could not read cache stats:', err);
      }
    }
    return Response.json({ services: [postgres, valkey], cache, approverKeyRequired: approverKeyConfigured() } satisfies HealthReport);
  } catch (err) {
    return errorResponse(err);
  }
}
