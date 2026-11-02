import { BOOK_SELECT_COLUMNS, buildFilterConditions } from '@/lib/search/catalog-query';
import type { Book, CatalogSearchFilters } from '@/lib/types/rag';

/**
 * ADR-0002: pure helpers for the pgvector semantic recall channel.
 * No DB/HTTP access here — SQL builders and pool merging only, so the
 * merging/parameter logic is unit-testable without a database.
 */

export const DEFAULT_SEMANTIC_TOP_K = 100;

/**
 * Build the ANN query for the semantic recall channel.
 * Param $1 is the query embedding (text cast to `vector` by the caller),
 * the remaining params come from the shared hard-filter builder.
 */
export function buildVectorSearchQuery(
  filters: CatalogSearchFilters,
  options: { topK?: number; startParamIndex?: number } = {},
): { sql: string; params: unknown[] } {
  const topK = Math.max(1, Math.floor(options.topK ?? DEFAULT_SEMANTIC_TOP_K));
  const startParamIndex = options.startParamIndex ?? 2;
  const filter = buildFilterConditions(filters, startParamIndex);
  const conditions = ['embedding IS NOT NULL', ...filter.conditions];

  return {
    sql: `
      SELECT${BOOK_SELECT_COLUMNS}
      FROM books
      WHERE ${conditions.join(' AND ')}
      ORDER BY embedding <=> $1::vector
      LIMIT ${topK}
    `,
    params: filter.params,
  };
}

/**
 * Merge the keyword recall pool with the vector recall pool.
 * Books present in both pools keep their keyword-pool copy (it carries the
 * keyword-specific signals); vector-only books are appended after the
 * keyword pool. The merged list is re-ranked downstream, so pool order
 * only matters as a stable tie-breaker.
 */
export function mergeRecallPools(primary: Book[], secondary: Book[]): Book[] {
  const seen = new Set<string>();
  const merged: Book[] = [];

  for (const book of primary) {
    if (book && book.book_id && !seen.has(book.book_id)) {
      seen.add(book.book_id);
      merged.push(book);
    }
  }
  for (const book of secondary) {
    if (book && book.book_id && !seen.has(book.book_id)) {
      seen.add(book.book_id);
      merged.push(book);
    }
  }
  return merged;
}
