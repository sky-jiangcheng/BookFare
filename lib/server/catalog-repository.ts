import 'server-only';

import { sql } from '@vercel/postgres';

import { embedQueryText, vectorToPgLiteral } from '@/lib/ai/embeddings';
import config, { isFulltextRankEnabled, isGraphNeighborsEnabled, isSemanticRecallEnabled } from '@/lib/config/environment';
import { assertEmbeddingDimension } from '@/lib/embedding-dimension.mjs';
import { getStoredEmbeddingDimension } from '@/lib/server/embedding-dimension';
import {
  BOOK_SELECT_COLUMNS,
  buildCatalogTextSearch,
  buildFilterConditions,
  SIMPLE_RERANK_THRESHOLD,
} from '@/lib/search/catalog-query';
import { buildTsQueryExpression, normalizeFtsScores } from '@/lib/search/fulltext-rank';
import {
  buildGraphNeighborQuery,
  computeGraphScores,
  mergeGraphNeighbors,
} from '@/lib/search/graph-recall';
import { buildCatalogSearchTerms, rerankCatalogBooks } from '@/lib/search/query-rerank';
import { buildVectorSearchQuery, mergeRecallPools } from '@/lib/search/semantic-recall';
import type { Book, CatalogSearchFilters, FeedbackStats } from '@/lib/types/rag';



interface CatalogApiBook {
  book_id?: string | number;
  id?: string | number;
  title: string;
  author?: string | null;
  publisher?: string | null;
  publication_year?: number | null;
  price?: number | null;
  stock?: number | null;
  category?: string | null;
  description?: string | null;
  cover_url?: string | null;
  relevance_score?: number | null;
  clc_code?: string | null;
  age_min?: number | null;
  age_max?: number | null;
}

/** Check if a book ID matches standard ISBN-13 format (978/979 + 10 digits) */
function isAbnormalId(id: string): boolean {
  return !/^97[89]\d{10}$/.test(id) && !/^\d{10}$/.test(id);
}

function mapBook(record: CatalogApiBook): Book {
  const bookId = record.book_id ?? record.id;
  if (!bookId) {
    throw new Error('Catalog record is missing book_id');
  }

  const idStr = String(bookId);
  return {
    book_id: idStr,
    title: record.title,
    author: record.author ?? 'Unknown Author',
    publisher: record.publisher ?? 'Unknown Publisher',
    publication_year: record.publication_year ?? undefined,
    price: Number(record.price ?? 0),
    stock: Number(record.stock ?? 0),
    category: record.category ?? 'general',
    description: record.description ?? '',
    cover_url: record.cover_url ?? undefined,
    relevance_score: Number(record.relevance_score ?? 0),
    is_abnormal_id: isAbnormalId(idStr),
    clc_code: record.clc_code ?? undefined,
    age_min: record.age_min !== null && record.age_min !== undefined ? Number(record.age_min) : undefined,
    age_max: record.age_max !== null && record.age_max !== undefined ? Number(record.age_max) : undefined,
  };
}

function normalizeBooks(records: CatalogApiBook[]): Book[] {
  return records.map(mapBook);
}

/**
 * Build WHERE conditions and params for catalog search filters.
 * startParamIndex specifies the first `$N` parameter number.
 *
 * Keyword text conditions come first, then the hard filters shared with the
 * vector recall channel (buildFilterConditions).
 */
function buildWhereConditions(
  filters: CatalogSearchFilters,
  startParamIndex: number,
): { conditions: string[]; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIdx = startParamIndex;

  const searchTerms = filters.search_terms?.length
    ? filters.search_terms
    : buildCatalogSearchTerms(filters.query ?? '');
  const textSearch = buildCatalogTextSearch(searchTerms, paramIdx);
  if (textSearch.condition) {
    conditions.push(textSearch.condition);
    params.push(...textSearch.params);
    paramIdx += textSearch.params.length;
  }

  const filter = buildFilterConditions(filters, paramIdx);
  conditions.push(...filter.conditions);
  params.push(...filter.params);

  return { conditions, params };
}

/**
 * 搜索目录：关键词 ILIKE 搜索 + 筛选。
 * query 来自用户自由文本，无 query 时仅按筛选条件返回热门图书。
 */
export async function searchCatalogFromDatabase(filters: CatalogSearchFilters): Promise<Book[]> {
  const { conditions, params } = buildWhereConditions(filters, 1);
  const searchTerms = filters.search_terms?.length
    ? filters.search_terms
    : buildCatalogSearchTerms(filters.query ?? '');

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const safeLimit = filters.limit !== undefined
    ? Math.max(1, Math.min(10000, Math.floor(filters.limit)))
    : (filters.page !== undefined ? 30 : 500);
  const page = filters.page !== undefined ? Math.max(1, filters.page) : 1;
  const offset = (page - 1) * safeLimit;

  const query = `
    SELECT${BOOK_SELECT_COLUMNS}
    FROM books
    ${whereClause}
    ORDER BY COALESCE(popularity_score, 0) DESC, COALESCE(updated_at, NOW()) DESC
    LIMIT ${safeLimit} OFFSET ${offset}
  `;

  const books = normalizeBooks((await sql.query<CatalogApiBook>(query, params)).rows);

  // ADR-0002: expand the candidate pool with pgvector semantic recall.
  // Only for the non-paged search flow — paged browsing keeps deterministic
  // pagination. Any failure here degrades to the keyword-only pool.
  let candidates = books;
  if (isSemanticRecallEnabled() && filters.query && filters.page === undefined) {
    try {
      candidates = await expandWithSemanticRecall(books, filters);
    } catch (error) {
      console.warn('[catalog-repository] Semantic recall skipped:', error);
    }
  }

  // ADR-0003: full-text ranking signal. Scores the whole candidate pool in
  // one targeted query; failure (e.g. search_tsv column not migrated yet)
  // degrades to the manual rerank weights only.
  if (isFulltextRankEnabled() && searchTerms.length > 0 && candidates.length > 0) {
    const tsQuery = buildTsQueryExpression(searchTerms);
    if (tsQuery) {
      try {
        await assignFtsScores(candidates, tsQuery);
      } catch (error) {
        console.warn('[catalog-repository] Full-text scoring skipped:', error);
      }
    }
  }

  // ADR-0004: expand the pool with 1-2 hop neighbors from the domain graph.
  // Seeds are the current pool leaders; failure (e.g. book_edges not built
  // yet) degrades to the keyword/semantic pool as-is.
  if (isGraphNeighborsEnabled() && candidates.length > 0) {
    try {
      candidates = await expandWithGraphNeighbors(candidates, filters);
    } catch (error) {
      console.warn('[catalog-repository] Graph neighbor expansion skipped:', error);
    }
  }

  const feedbackStats: Record<string, FeedbackStats> = {};
  try {
    const { getFeedbackStatsBatch } = await import('@/lib/feedback/feedback-store');
    const { hasRedisConfig } = await import('@/lib/config/environment');
    if (hasRedisConfig() && candidates.length > 0) {
      const batchResult = await getFeedbackStatsBatch(candidates.map((b) => b.book_id));
      for (const [bookId, stats] of batchResult) {
        if (stats) {
          feedbackStats[bookId] = stats;
        }
      }
    }
  } catch (error) {
    console.warn('[catalog-repository] Failed to load feedback stats:', error);
  }

  if (candidates.length > SIMPLE_RERANK_THRESHOLD) {
    return applySimpleRerank(candidates, filters, searchTerms, feedbackStats);
  }

  return await rerankCatalogBooks(
    candidates,
    [filters.query, ...searchTerms].filter(Boolean).join(' '),
    filters.requirement,
    feedbackStats,
  );
}

/**
 * ADR-0002 semantic recall channel: embed the query once, fetch ANN top-K
 * with the same hard filters, and merge into the keyword pool (dedup by id).
 */
async function expandWithSemanticRecall(
  keywordBooks: Book[],
  filters: CatalogSearchFilters,
): Promise<Book[]> {
  const queryText = (filters.query ?? '').trim();
  if (!queryText) {
    return keywordBooks;
  }

  // Embed at the dimension the column actually uses, not whatever the
  // environment says — a mismatch here fails the whole ANN comparison.
  const dimension = await getStoredEmbeddingDimension();
  const embedding = await embedQueryText(queryText, { dimensions: dimension });
  assertEmbeddingDimension(embedding, dimension);

  const { sql: vectorSql, params: vectorParams } = buildVectorSearchQuery(filters, {
    topK: config.search.semanticTopK,
  });
  const result = await sql.query<CatalogApiBook>(
    vectorSql,
    [vectorToPgLiteral(embedding), ...vectorParams],
  );
  return mergeRecallPools(keywordBooks, normalizeBooks(result.rows));
}

/**
 * ADR-0003: compute ts_rank_cd scores for the candidate pool in one query and
 * assign the normalized [0, 1] values to each book's fts_score.
 */
async function assignFtsScores(books: Book[], tsQueryText: string): Promise<void> {
  if (books.length === 0) {
    return;
  }

  const ids = books.map((b) => b.book_id);
  const result = await sql.query<{ book_id: string | number; fts_score: string | number }>(
    `
      SELECT
        id AS book_id,
        ts_rank_cd(search_tsv, to_tsquery('simple', $1)) AS fts_score
      FROM books
      WHERE id = ANY($2::bigint[])
    `,
    [tsQueryText, ids],
  );

  const normalized = normalizeFtsScores(
    result.rows.map((row) => ({ bookId: String(row.book_id), raw: Number(row.fts_score) })),
  );
  for (const book of books) {
    const score = normalized.get(book.book_id);
    if (score !== undefined) {
      book.fts_score = score;
    }
  }
}

/**
 * ADR-0004: take the pool leaders as seeds, walk 1-2 hops over book_edges,
 * fetch the neighbor rows (same hard filters) and merge with S_graph scores.
 */
async function expandWithGraphNeighbors(
  candidates: Book[],
  filters: CatalogSearchFilters,
): Promise<Book[]> {
  const seedIds = candidates
    .slice(0, config.search.graphSeedCount)
    .map((b) => b.book_id);
  if (seedIds.length === 0) {
    return candidates;
  }

  const { sql: graphSql, params: graphParams } = buildGraphNeighborQuery(seedIds, {
    depth: config.search.graphDepth,
    limit: config.search.graphNeighborLimit,
  });
  const walkResult = await sql.query<{ book_id: string | number; depth: number; weight: number }>(
    graphSql,
    graphParams,
  );
  const graphScores = computeGraphScores(
    walkResult.rows.map((row) => ({
      book_id: String(row.book_id),
      depth: Number(row.depth),
      weight: Number(row.weight),
    })),
  );
  if (graphScores.size === 0) {
    return candidates;
  }

  const neighborIds = [...graphScores.keys()];
  const filter = buildFilterConditions(filters, 2);
  const whereClause = filter.conditions.length > 0
    ? `WHERE id = ANY($1::bigint[]) AND ${filter.conditions.join(' AND ')}`
    : 'WHERE id = ANY($1::bigint[])';
  const booksResult = await sql.query<CatalogApiBook>(
    `
      SELECT${BOOK_SELECT_COLUMNS}
      FROM books
      ${whereClause}
    `,
    [neighborIds, ...filter.params],
  );

  return mergeGraphNeighbors(candidates, normalizeBooks(booksResult.rows), graphScores);
}

export async function getBookDetailsFromDatabase(bookId: string): Promise<Book | null> {
  const query = `
    SELECT
      b.id AS book_id,
      b.title,
      b.author,
      COALESCE(b.publisher, 'Unknown Publisher') AS publisher,
      b.publication_year,
      COALESCE(b.price, 0) AS price,
      COALESCE(b.stock, 0) AS stock,
      COALESCE(b.book_category, 'general') AS category,
      COALESCE(bd.description, '') AS description,
      b.cover_url,
      COALESCE(b.popularity_score, 0) AS relevance_score,
      b.clc_code,
      b.age_min,
      b.age_max
    FROM books b
    LEFT JOIN book_descriptions bd ON bd.book_id = b.id
    WHERE b.id = $1
    LIMIT 1
  `;

  const result = await sql.query<CatalogApiBook>(query, [bookId]);
  return result.rows[0] ? mapBook(result.rows[0]) : null;
}

/**
 * Lightweight rerank for large result sets (> SIMPLE_RERANK_THRESHOLD).
 * Skips expensive per-book scoring; applies field-weighted scoring only.
 */
export function applySimpleRerank(
  books: Book[],
  filters: CatalogSearchFilters,
  searchTerms: string[],
  feedbackStats: Record<string, FeedbackStats>,
): Book[] {
  const query = [filters.query, ...searchTerms].filter(Boolean).join(' ').toLowerCase();
  const terms = query ? query.match(/[\p{Script=Han}]{2,}|[\p{L}\p{N}]{2,}/gu) ?? [] : [];
  const stopwords = new Set(['推荐', '书', '书籍', '书单', '适合', '相关', '一些', '一个', '一本', '给我', '来', '看看', '可以', '想要', '希望', '关于', '比较', '家里', '家人', '最好', '请', '帮我', '有哪些', '哪些']);

  // Requirement-derived signals that the default rerank honors but the
  // lightweight path previously dropped. Precompute them once so the per-book
  // loop only does cheap field checks. See docs/rerank-weights-audit.md §三
  // (问题 3) for why these two — exclusion keywords and age fit — must not
  // silently disappear at the >500-row threshold.
  const requirement = filters.requirement;
  const excludedKeywords = (requirement?.constraints?.exclude_keywords ?? []).map((kw) =>
    kw.toLowerCase(),
  );
  const libraryType = requirement?.inferred_library_type;

  const scored = books.map((book) => {
    let score = Math.log1p(Math.max(0, book.relevance_score ?? 0)) * 0.35;
    const title = book.title.toLowerCase();
    const author = book.author.toLowerCase();
    const category = book.category.toLowerCase();
    const haystack = `${title} ${author} ${category}`;

    for (const term of terms) {
      if (stopwords.has(term)) continue;
      if (title.includes(term)) score += 3.5;
      else if (category.includes(term)) score += 2.6;
      else if (author.includes(term)) score += 1.4;
      else if (haystack.includes(term)) score += 0.6;
    }

    // Exclusion constraint penalty (mirrors computeBookScore: −10). A book that
    // matches a user-supplied exclusion keyword (e.g. "教材", "教辅") is pushed
    // down hard so it effectively drops out of the top results.
    if (
      excludedKeywords.length > 0 &&
      excludedKeywords.some((keyword) => haystack.includes(keyword))
    ) {
      score -= 10;
    }

    // Age-range fit for child / teen library types (mirrors computeBookScore:
    // ±3.0). Books whose stated age band overlaps the library's audience are
    // boosted; off-target books are demoted.
    if (libraryType === '小学' || libraryType === '初高中') {
      const ageMin = book.age_min != null ? Number(book.age_min) : null;
      const ageMax = book.age_max != null ? Number(book.age_max) : null;
      if (ageMin !== null && ageMax !== null) {
        const fits =
          libraryType === '小学' ? ageMin <= 12 && ageMax >= 6 : ageMin <= 18 && ageMax >= 12;
        score += fits ? 3.0 : -3.0;
      }
    }

    const bookId = book.book_id;
    if (feedbackStats?.[bookId]) {
      const s = feedbackStats[bookId];
      score += Math.log1p(Number(s.positiveCount || 0)) * 1.5 - Number(s.negativeCount || 0) * 0.8;
    }

    return { book, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.map(({ book, score }) => ({ ...book, relevance_score: score }));
}

const EXPORT_BATCH_SIZE = 500;

/**
 * Stream books matching filters in batches using keyset pagination.
 * Returns an async generator that yields batches, avoiding loading all rows into memory.
 * Uses keyset pagination on id ASC for O(1) per-batch cost.
 */
export async function* streamBooksForExport(
  filters: CatalogSearchFilters,
): AsyncGenerator<Book[], void, undefined> {
  const { conditions: baseConditions, params: baseParams } = buildWhereConditions(filters, 1);
  // paramIdx is read-only here — it points past the WHERE-clause placeholders
  // so the keyset pagination cursor and LIMIT can reuse the same counter.
  const paramIdx = 1 + baseParams.length;

  const whereClause = baseConditions.length > 0 ? `WHERE ${baseConditions.join(' AND ')}` : '';
  const safeLimit = filters.limit !== undefined
    ? Math.max(1, Math.min(100000, Math.floor(filters.limit)))
    : 10000;
  let lastId = '0';
  let totalFetched = 0;

  while (totalFetched < safeLimit) {
    const batchSize = Math.min(EXPORT_BATCH_SIZE, safeLimit - totalFetched);
    const params = [...baseParams, lastId, batchSize];

    const query = `
      SELECT${BOOK_SELECT_COLUMNS}
      FROM books
      ${whereClause}
        ${baseConditions.length > 0 ? 'AND' : 'WHERE'} id > $${paramIdx}
      ORDER BY id ASC
      LIMIT $${paramIdx + 1}
    `;

    const result = await sql.query<CatalogApiBook>(query, params);
    const batch = normalizeBooks(result.rows);

    if (batch.length === 0) break;

    yield batch;
    totalFetched += batch.length;
    lastId = batch[batch.length - 1].book_id;
  }
}

export async function getPopularBooksFromDatabase(count: number): Promise<Book[]> {
  const query = `
    SELECT${BOOK_SELECT_COLUMNS}
    FROM books
    ORDER BY
      COALESCE(popularity_score, 0) DESC,
      COALESCE(updated_at, NOW()) DESC
    LIMIT $1
  `;

  const result = await sql.query<CatalogApiBook>(query, [count]);
  return normalizeBooks(result.rows);
}
