import 'server-only';

import { sql } from '@vercel/postgres';

import type { Book } from '@/lib/types/rag';

const FILTER_CACHE_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 50; // 最大缓存条目数，防止内存泄漏

type FilterStatus = {
  enabled: boolean;
  keywords: string[];
  sources: {
    database: boolean;
    env: boolean;
  };
};

const filterCache: Record<
  string,
  {
    expiresAt: number;
    status: FilterStatus;
  }
> = {};

/**
 * 清理过期的缓存条目，避免内存泄漏
 */
function cleanupExpiredCache(): void {
  const now = Date.now();
  const keys = Object.keys(filterCache);
  
  // 清理过期条目
  for (const key of keys) {
    if (filterCache[key].expiresAt <= now) {
      delete filterCache[key];
    }
  }
  
  // 如果仍然超过最大条目数，删除最早过期的条目
  const remainingKeys = Object.keys(filterCache);
  if (remainingKeys.length > MAX_CACHE_ENTRIES) {
    const sortedByExpiry = remainingKeys.sort(
      (a, b) => filterCache[a].expiresAt - filterCache[b].expiresAt
    );
    const toDelete = sortedByExpiry.slice(0, remainingKeys.length - MAX_CACHE_ENTRIES);
    for (const key of toDelete) {
      delete filterCache[key];
    }
  }
}

function parseKeywordList(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }

  return raw
    .split(/[\n,;，；]+/)
    .map((keyword) => keyword.trim())
    .filter(Boolean);
}

function deduplicateKeywords(keywords: string[]): string[] {
  return Array.from(new Set(keywords.map((keyword) => keyword.trim()).filter(Boolean)))
    .sort((a, b) => b.length - a.length);
}

async function loadDatabaseKeywords(category?: string): Promise<string[]> {
  if (!category || category === 'none') {
    return [];
  }

  try {
    const result = await sql<{ keyword: string }>`
      SELECT keyword
      FROM filter_keywords
      WHERE library_code = ${category} AND is_active = TRUE
      ORDER BY char_length(keyword) DESC, keyword ASC
    `;

    return result.rows.map((row) => row.keyword).filter(Boolean);
  } catch (error) {
    console.warn('[filters] Failed to load database filter keywords:', error);
    return [];
  }
}

function getBookSearchText(book: Book): string {
  return [
    book.title,
    book.author,
    book.publisher,
    book.category,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/**
 * Pre-compile keywords into a combined regex for O(1) matching per book.
 * Falls back to loop for small keyword sets.
 */
function createBlockedKeywordMatcher(keywords: string[]): {
  test: (haystack: string) => string | null;
} {
  if (keywords.length === 0) {
    return { test: () => null };
  }

  if (keywords.length <= 5) {
    return {
      test: (haystack: string) => {
        for (const kw of keywords) {
          if (haystack.includes(kw)) return kw;
        }
        return null;
      },
    };
  }

  const escaped = keywords.map((kw) =>
    kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  );
  const pattern = new RegExp(escaped.join('|'));
  return {
    test: (haystack: string) => {
      const match = haystack.match(pattern);
      return match ? match[0] : null;
    },
  };
}

/** Cached matcher instance for the current keyword set */
let cachedMatcher: {
  matcher: ReturnType<typeof createBlockedKeywordMatcher>;
  keywords: string[];
} | null = null;

function getMatcher(keywords: string[]): ReturnType<typeof createBlockedKeywordMatcher> {
  if (cachedMatcher && cachedMatcher.keywords === keywords) {
    return cachedMatcher.matcher;
  }
  const matcher = createBlockedKeywordMatcher(keywords);
  cachedMatcher = { matcher, keywords };
  return matcher;
}

function findBlockedKeyword(book: Book, keywords: string[]): string | null {
  const haystack = getBookSearchText(book);
  return getMatcher(keywords).test(haystack);
}

export async function getFilterStatus(
  category?: string,
  forceRefresh: boolean = false
): Promise<FilterStatus> {
  const cacheKey = category || 'none';
  const now = Date.now();
  
  // 定期清理过期缓存
  cleanupExpiredCache();
  
  if (!forceRefresh && filterCache[cacheKey] && filterCache[cacheKey].expiresAt > now) {
    return filterCache[cacheKey].status;
  }

  const envKeywords = parseKeywordList(process.env.BLOCKED_KEYWORDS || process.env.RAG_BLOCKED_KEYWORDS);
  const databaseKeywords = await loadDatabaseKeywords(category);
  const keywords = deduplicateKeywords([...databaseKeywords, ...envKeywords]);

  const status: FilterStatus = {
    enabled: keywords.length > 0,
    keywords,
    sources: {
      database: databaseKeywords.length > 0,
      env: envKeywords.length > 0,
    },
  };

  filterCache[cacheKey] = {
    expiresAt: now + FILTER_CACHE_TTL_MS,
    status,
  };

  return status;
}

export async function filterBlockedBooks<T extends Book>(
  books: T[],
  category?: string
): Promise<{
  books: T[];
  blocked: Array<{ book: T; keyword: string }>;
}> {
  if (books.length === 0) {
    return { books: [], blocked: [] };
  }

  const status = await getFilterStatus(category);
  if (!status.enabled) {
    return { books, blocked: [] };
  }

  const visibleBooks: T[] = [];
  const blocked: Array<{ book: T; keyword: string }> = [];

  for (const book of books) {
    const keyword = findBlockedKeyword(book, status.keywords);
    if (keyword) {
      blocked.push({ book, keyword });
      continue;
    }
    visibleBooks.push(book);
  }

  return { books: visibleBooks, blocked };
}

export async function assertBookVisible<T extends Book>(
  book: T,
  category?: string
): Promise<T> {
  const result = await filterBlockedBooks([book], category);
  if (result.books.length === 0) {
    const keyword = result.blocked[0]?.keyword ?? 'content_filter';
    throw new Error(`Book hidden by content filter: ${keyword}`);
  }

  return result.books[0];
}
