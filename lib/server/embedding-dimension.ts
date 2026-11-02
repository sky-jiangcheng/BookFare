import 'server-only';

import { sql } from '@vercel/postgres';

import { parseVectorColumnDimension } from '@/lib/embedding-dimension.mjs';

/**
 * The pgvector column is the authority for the embedding dimension.
 *
 * The runtime embeds query text at whatever dimension `books.embedding`
 * actually uses, so a stale `EMBEDDING_DIMENSIONS` env var can never make the
 * query vector disagree with the stored vectors.
 */
let cachedDimension: Promise<number> | null = null;

async function queryColumnDimension(): Promise<number> {
  const { rows } = await sql.query<{ column_type: string }>(`
    SELECT format_type(a.atttypid, a.atttypmod) AS column_type
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'books'
      AND a.attname = 'embedding'
      AND a.attnum > 0
      AND NOT a.attisdropped
  `);

  const dimension = parseVectorColumnDimension(rows[0]?.column_type);
  if (dimension === null) {
    throw new Error(
      'books.embedding is missing or is not a dimensioned vector column — ' +
        'run `node scripts/vercel/init-db.mjs` to create it.',
    );
  }
  return dimension;
}

/**
 * Dimension of the `books.embedding` column, resolved once per instance.
 *
 * A failed lookup is not cached, so a transient database outage does not pin
 * the process to a broken state.
 */
export function getStoredEmbeddingDimension(): Promise<number> {
  if (!cachedDimension) {
    cachedDimension = queryColumnDimension().catch((error: unknown) => {
      cachedDimension = null;
      throw error;
    });
  }
  return cachedDimension;
}
