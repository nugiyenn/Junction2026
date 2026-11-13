import 'server-only';
import { Pool } from 'pg';

declare global {
  var pgPool: Pool | undefined;
}

/**
 * Creates the pool on first use so a missing URL only fails the call that needs it.
 * Cached on `global` so dev hot reloads reuse one pool instead of leaking connections.
 */
export function getPool(): Pool {
  if (global.pgPool) return global.pgPool;

  const connectionString = process.env.AIVEN_DATABASE_URL;
  if (!connectionString) throw new Error('Missing AIVEN_DATABASE_URL: cannot connect to aiven');

  // pg treats `sslmode=require` in the URL as full certificate verification, which fails on
  // Aiven's own CA and overrides the `ssl` option below, so drop it and keep the connection encrypted.
  const url = new URL(connectionString);
  url.searchParams.delete('sslmode');

  global.pgPool = new Pool({
    connectionString: url.toString(),
    ssl: { rejectUnauthorized: false },
    max: 3, // one pool per serverless instance; keep small to stay under Aiven connection limits
  });
  return global.pgPool;
}

export async function enableVectorExtension() {
  await getPool().query('CREATE EXTENSION IF NOT EXISTS vector;');
}

const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Hybrid search: pgvector cosine distance on the table's `embedding` column, plus an optional SQL filter.
 *
 * `whereClause` is inserted as raw SQL, so it must be written by us and never contain user input.
 * Put values in `whereParams` and refer to them as $3, $4, ... ($1 = embedding, $2 = limit).
 *   e.g. vectorSearch('products', emb, 5, 'in_stock = TRUE AND category = $3', ['tools'])
 *
 * The `embedding` column is dropped from returned rows; `similarity` (1 = identical) is added.
 */
export async function vectorSearch<T extends Record<string, unknown> = Record<string, unknown>>(
  table: string,
  embedding: number[],
  limit = 5,
  whereClause = '',
  whereParams: unknown[] = []
): Promise<(T & { similarity: number })[]> {
  if (!SQL_IDENTIFIER.test(table)) throw new Error(`Invalid table name: ${table}`);

  const { rows } = await getPool().query(
    `
    SELECT *, 1 - (embedding <=> $1::vector) AS similarity
    FROM "${table}"
    ${whereClause ? `WHERE ${whereClause}` : ''}
    ORDER BY embedding <=> $1::vector ASC
    LIMIT $2;
    `,
    [`[${embedding.join(',')}]`, limit, ...whereParams]
  );

  for (const row of rows) delete row.embedding;
  return rows;
}
