import 'server-only';

import { sql } from '@vercel/postgres';

import { buildCatalogTextSearch, SIMPLE_RERANK_THRESHOLD } from '@/lib/search/catalog-query';
import { buildCatalogSearchTerms, rerankCatalogBooks } from '@/lib/search/query-rerank';
import type { Book, CatalogSearchFilters, FeedbackStats } from '@/lib/types/rag';

/**
 * Shared SELECT columns for book queries.
 * Used by searchCatalogFromDatabase, streamBooksForExport, and getPopularBooksFromDatabase.
 */
const BOOK_SELECT_COLUMNS = `
  id AS book_id,
  title,
  author,
  COALESCE(publisher, 'Unknown Publisher') AS publisher,
  publication_year,
  COALESCE(price, 0) AS price,
  COALESCE(stock, 0) AS stock,
  COALESCE(book_category, 'general') AS category,
  '' AS description,
  cover_url,
  COALESCE(popularity_score, 0) AS relevance_score,
  clc_code,
  age_min,
  age_max
`;



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
 */
function buildWhereConditions(
  filters: CatalogSearchFilters,
  startParamIndex: number,
): { conditions: string[]; params: unknown[]; nextParamIndex: number } {
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

  if (filters.author) {
    params.push(`%${filters.author}%`);
    conditions.push(`author ILIKE $${paramIdx++}`);
  }
  if (filters.price_min !== undefined) {
    params.push(filters.price_min);
    conditions.push(`price >= $${paramIdx++}`);
  }
  if (filters.price_max !== undefined) {
    params.push(filters.price_max);
    conditions.push(`price <= $${paramIdx++}`);
  }
  if (filters.publication_year_min !== undefined) {
    params.push(filters.publication_year_min);
    conditions.push(`publication_year >= $${paramIdx++}`);
  }
  if (filters.publication_year_max !== undefined) {
    params.push(filters.publication_year_max);
    conditions.push(`publication_year <= $${paramIdx++}`);
  }
  if (filters.categories && filters.categories.length > 0) {
    const placeholders = filters.categories.map(() => `$${paramIdx++}`).join(',');
    conditions.push(`book_category IN (${placeholders})`);
    params.push(...filters.categories);
  }

  if (filters.library_category && filters.library_category !== 'none') {
    params.push(filters.library_category);
    conditions.push(`library_codes @> ARRAY[$${paramIdx++}]::text[]`);
  }

  return { conditions, params, nextParamIndex: paramIdx };
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

  const feedbackStats: Record<string, FeedbackStats> = {};
  try {
    const { getFeedbackStatsBatch } = await import('@/lib/feedback/feedback-store');
    const { hasRedisConfig } = await import('@/lib/config/environment');
    if (hasRedisConfig() && books.length > 0) {
      const batchResult = await getFeedbackStatsBatch(books.map((b) => b.book_id));
      for (const [bookId, stats] of batchResult) {
        if (stats) {
          feedbackStats[bookId] = stats;
        }
      }
    }
  } catch (error) {
    console.warn('[catalog-repository] Failed to load feedback stats:', error);
  }

  if (books.length > SIMPLE_RERANK_THRESHOLD) {
    return applySimpleRerank(books, filters, searchTerms, feedbackStats);
  }

  return await rerankCatalogBooks(
    books,
    [filters.query, ...searchTerms].filter(Boolean).join(' '),
    filters.requirement,
    feedbackStats,
  );
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
function applySimpleRerank(
  books: Book[],
  filters: CatalogSearchFilters,
  searchTerms: string[],
  feedbackStats: Record<string, FeedbackStats>,
): Book[] {
  const query = [filters.query, ...searchTerms].filter(Boolean).join(' ').toLowerCase();
  const terms = query ? query.match(/[\p{Script=Han}]{2,}|[\p{L}\p{N}]{2,}/gu) ?? [] : [];
  const stopwords = new Set(['推荐', '书', '书籍', '书单', '适合', '相关', '一些', '一个', '一本', '给我', '来', '看看', '可以', '想要', '希望', '关于', '比较', '家里', '家人', '最好', '请', '帮我', '有哪些', '哪些']);

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
