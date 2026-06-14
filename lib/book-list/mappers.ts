import 'server-only';

import type { RequirementAnalysis, RecommendedBook } from '@/lib/types/rag';
import type {
  BookRecommendation,
  CategoryRequirement,
  ParsedRequirements,
} from '@/lib/book-list/types';

/** Stable positive int from string (session id, legacy numeric book_id). */
export function stableIntFromString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(31, h) + s.charCodeAt(i);
  }
  return Math.abs(h) || 1;
}

export function requirementAnalysisToParsed(
  req: RequirementAnalysis,
  defaultExcludeTextbooks = true,
): ParsedRequirements {
  const cats = req.categories;
  const n = Math.max(1, cats.length);
  const categories: CategoryRequirement[] = cats.map((category) => ({
    category,
    percentage: Math.round((100 / n) * 100) / 100,
    count: 0,
  }));

  const constraints: string[] = [];
  if (req.constraints.budget !== undefined) {
    constraints.push(`预算总价不超过 ¥${req.constraints.budget.toFixed(2)}`);
  }
  if (req.constraints.target_count !== undefined) {
    constraints.push(`目标册数约 ${req.constraints.target_count} 本`);
  }
  if (req.constraints.author) {
    constraints.push(`作者偏好: ${req.constraints.author}`);
  }
  if (req.constraints.price_min !== undefined || req.constraints.price_max !== undefined) {
    constraints.push(
      `单价区间: ¥${req.constraints.price_min ?? 0} - ¥${req.constraints.price_max ?? '∞'}`,
    );
  }
  if (req.constraints.publication_year_min !== undefined) {
    constraints.push(`出版年份不早于 ${req.constraints.publication_year_min} 年`);
  }
  if (req.constraints.exclude_keywords?.length) {
    constraints.push(`排除: ${req.constraints.exclude_keywords.join('、')}`);
  }

  const audience =
    req.preferences.find((p) => p.startsWith('受众:'))?.replace(/^受众:/, '')?.trim() ?? null;

  return {
    target_audience: audience,
    cognitive_level: null,
    categories,
    keywords: [...req.keywords],
    constraints,
    exclude_textbooks: defaultExcludeTextbooks,
    min_cognitive_level: null,
  };
}

/**
 * Rebuild structured requirement for the Vercel RAG pipeline without a second LLM parse
 * (used after /book-list/parse or when the client sends `requirements` directly).
 */
export function parsedRequirementsToRequirementAnalysis(
  originalQuery: string,
  parsed: ParsedRequirements,
  limit: number,
): RequirementAnalysis {
  const categories = (parsed.categories ?? [])
    .map((c) => String(c.category ?? '').trim())
    .filter(Boolean);

  const constraints: RequirementAnalysis['constraints'] = {
    target_count: limit,
  };

  for (const line of parsed.constraints ?? []) {
    const budgetMatch = line.match(/预算[^\d¥]*[¥]?\s*(\d+(?:\.\d+)?)/);
    if (budgetMatch) {
      constraints.budget = Number(budgetMatch[1]);
      continue;
    }
    const countMatch = line.match(/目标册数约\s*(\d+)/);
    if (countMatch) {
      constraints.target_count = Number(countMatch[1]);
    }
    const publicationYearMatch = line.match(/出版年份不早于\s*(\d{4})\s*年/);
    if (publicationYearMatch) {
      constraints.publication_year_min = Number(publicationYearMatch[1]);
    }
    if (line.startsWith('排除:')) {
      const rest = line.replace(/^排除:\s*/, '');
      const parts = rest.split(/[、,，]/).map((s) => s.trim()).filter(Boolean);
      if (parts.length) {
        constraints.exclude_keywords = [...(constraints.exclude_keywords ?? []), ...parts];
      }
    }
  }

  const preferences: string[] = [];
  if (parsed.target_audience) {
    preferences.push(`受众:${parsed.target_audience}`);
  }
  if (parsed.cognitive_level) {
    preferences.push(`认知:${parsed.cognitive_level}`);
  }

  const baseQuery =
    originalQuery.trim() ||
    parsed.keywords.join(' ') ||
    (categories[0] ? `${categories[0]} 相关读物` : '');

  const baseKeywords = parsed.keywords.length > 0 ? [...parsed.keywords] : [...categories];
  return {
    original_query: baseQuery || '图书推荐',
    categories: categories.length > 0 ? categories : ['综合'],
    keywords: baseKeywords,
    expanded_search_terms: baseKeywords,
    constraints,
    preferences,
    needs_clarification: false,
    clarification_questions: [],
  };
}

export function buildUserQueryFromParsed(
  parsed: ParsedRequirements,
  limit: number,
  fallback?: string,
): string {
  const parts: string[] = [];
  if (fallback?.trim()) {
    parts.push(fallback.trim());
  }
  if (parsed.keywords.length) {
    parts.push(`关键词: ${parsed.keywords.join('、')}`);
  }
  if (parsed.categories.length) {
    parts.push(
      `分类比例: ${parsed.categories
        .map((c) => `${c.category}${c.percentage ? ` ${c.percentage}%` : ''}`)
        .join('，')}`,
    );
  }
  if (parsed.constraints.length) {
    parts.push(`约束: ${parsed.constraints.join('；')}`);
  }
  if (parsed.target_audience) {
    parts.push(`目标受众: ${parsed.target_audience}`);
  }
  parts.push(`请推荐约 ${limit} 本书。`);
  return parts.join('\n');
}

export function recommendedBookToApiBook(
  book: RecommendedBook,
  matchScore: number,
): BookRecommendation {
  const idNum = /^\d+$/.test(book.book_id) ? Number(book.book_id) : stableIntFromString(book.book_id);
  const normalizedScore = Math.min(1, Math.max(0, matchScore));

  return {
    book_id: idNum,
    barcode: `BK-${book.book_id}`.slice(0, 32),
    title: book.title,
    author: book.author || null,
    publisher: book.publisher || null,
    publication_year: book.publication_year ?? null,
    price: book.price,
    stock: book.stock ?? null,
    category: book.category || null,
    cognitive_level: null,
    difficulty_level: null,
    match_score: normalizedScore,
    score: normalizedScore * 100,
    source: book.source || '智能推荐',
    remark: book.explanation || null,
  };
}
