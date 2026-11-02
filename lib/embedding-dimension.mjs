/**
 * Canonical embedding dimension for the `books.embedding` pgvector column.
 *
 * Single source of truth shared by both sides of the toolchain:
 * - the Next.js runtime (TypeScript, via `allowJs`)
 * - the Node maintenance scripts (plain `.mjs`, no build step)
 *
 * Keep this module dependency-free and never import `server-only` here —
 * the scripts run under plain Node and cannot resolve it.
 *
 * Changing the dimension requires migrating the column:
 *   node scripts/vercel/init-db.mjs --fix-dimension
 * followed by a re-run of the embedding backfill.
 */

/** Dimension used when `EMBEDDING_DIMENSIONS` is not set. */
export const DEFAULT_EMBEDDING_DIMENSIONS = 768;

/** Dimensions accepted by `gemini-embedding-001`. */
export const SUPPORTED_EMBEDDING_DIMENSIONS = [768, 1536, 3072];

/**
 * Resolve the configured embedding dimension.
 *
 * Throws on an unsupported value rather than silently falling back: a silent
 * fallback is what let the runtime and the pgvector column drift apart in the
 * first place.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {number}
 */
export function resolveEmbeddingDimensions(env = process.env) {
  const raw = env.EMBEDDING_DIMENSIONS;
  if (raw === undefined || raw === null || raw === '') {
    return DEFAULT_EMBEDDING_DIMENSIONS;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || !SUPPORTED_EMBEDDING_DIMENSIONS.includes(parsed)) {
    throw new Error(
      `Invalid EMBEDDING_DIMENSIONS="${raw}". Supported: ${SUPPORTED_EMBEDDING_DIMENSIONS.join(', ')}.`,
    );
  }
  return parsed;
}

/**
 * Parse the dimension out of a pgvector column type such as `vector(768)`.
 * Returns `null` for any other type — including a bare `vector`, which means
 * "unconstrained dimension" and therefore cannot be trusted.
 *
 * @param {string | null | undefined} columnType
 * @returns {number | null}
 */
export function parseVectorColumnDimension(columnType) {
  const match = /^vector\((\d+)\)$/.exec(String(columnType ?? '').trim());
  return match ? Number(match[1]) : null;
}

/**
 * Assert an embedding has the expected length.
 *
 * Fails with an actionable message here, instead of letting Postgres report
 * `expected N dimensions, got M` from deep inside a query where the error is
 * easy to miss.
 *
 * @param {number[] | null | undefined} values
 * @param {number} expected
 * @returns {number[] | null | undefined}
 */
export function assertEmbeddingDimension(values, expected) {
  const actual = Array.isArray(values) ? values.length : -1;
  if (actual !== expected) {
    throw new Error(
      `Embedding dimension mismatch: expected ${expected}, got ${actual}. ` +
        `The books.embedding column must be vector(${expected}); reconcile it with ` +
        '`node scripts/vercel/init-db.mjs --fix-dimension` and re-run the embedding backfill.',
    );
  }
  return values;
}
