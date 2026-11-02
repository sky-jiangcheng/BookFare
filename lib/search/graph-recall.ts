import type { Book } from '@/lib/types/rag';

/**
 * ADR-0004: pure helpers for the deterministic domain-graph recall channel
 * (book_edges + recursive CTE). No DB access here so the query building and
 * scoring logic is unit-testable without a database.
 */

/** Graph sub-score multiplier per hop depth (S_graph in the rerank). */
export const GRAPH_1HOP_WEIGHT = 2.0;
export const GRAPH_2HOP_WEIGHT = 1.0;

export const DEFAULT_GRAPH_SEED_COUNT = 10;
export const DEFAULT_GRAPH_DEPTH = 2;
export const DEFAULT_GRAPH_NEIGHBOR_LIMIT = 100;

export interface GraphWalkRow {
  book_id: string | number;
  depth: number;
  weight: number;
}

/**
 * Recursive CTE over book_edges: 1-2 hop neighbors of the seed books.
 * UNION (not UNION ALL) dedups visited nodes so cycles terminate.
 */
export function buildGraphNeighborQuery(
  seedIds: string[],
  options: { depth?: number; limit?: number } = {},
): { sql: string; params: unknown[] } {
  const depth = Math.max(1, Math.min(3, Math.floor(options.depth ?? DEFAULT_GRAPH_DEPTH)));
  const limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_GRAPH_NEIGHBOR_LIMIT));

  return {
    sql: `
      WITH RECURSIVE walk AS (
        SELECT e.to_book AS book_id, 1 AS depth, e.weight
        FROM book_edges e
        WHERE e.from_book = ANY($1::bigint[])
        UNION
        SELECT e.to_book, w.depth + 1, e.weight
        FROM book_edges e
        JOIN walk w ON e.from_book = w.book_id
        WHERE w.depth < $2
      )
      SELECT
        book_id,
        MIN(depth)::int AS depth,
        MAX(weight)::real AS weight
      FROM walk
      GROUP BY book_id
      LIMIT ${limit}
    `,
    params: [seedIds, depth],
  };
}

/**
 * Graph sub-score per neighbor book: 1-hop edges weigh double 2-hop edges,
 * scaled by the edge weight. Keeps the max when several paths reach a book.
 */
export function computeGraphScores(rows: GraphWalkRow[]): Map<string, number> {
  const scores = new Map<string, number>();
  for (const row of rows) {
    const depth = Number(row.depth);
    const weight = Number(row.weight);
    if (!Number.isFinite(depth) || !Number.isFinite(weight) || weight <= 0) continue;
    const score = (depth <= 1 ? GRAPH_1HOP_WEIGHT : GRAPH_2HOP_WEIGHT) * weight;
    const bookId = String(row.book_id);
    const existing = scores.get(bookId);
    if (existing === undefined || score > existing) {
      scores.set(bookId, score);
    }
  }
  return scores;
}

/**
 * Merge graph neighbors into the candidate pool. Pool books that are also
 * graph neighbors receive their S_graph bonus in place; new neighbor books
 * are appended with their bonus pre-applied. Final ordering is left to the
 * rerank, so pool order is only a tie-breaker.
 */
export function mergeGraphNeighbors(
  pool: Book[],
  neighborBooks: Book[],
  graphScores: Map<string, number>,
): Book[] {
  const inPool = new Set(pool.map((book) => book.book_id));

  for (const book of pool) {
    const score = graphScores.get(book.book_id);
    if (score !== undefined) {
      book.graph_score = score;
    }
  }

  const merged = [...pool];
  for (const book of neighborBooks) {
    if (inPool.has(book.book_id)) continue;
    const score = graphScores.get(book.book_id);
    merged.push(score !== undefined ? { ...book, graph_score: score } : book);
  }
  return merged;
}
