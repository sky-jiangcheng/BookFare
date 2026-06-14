// lib/agents/recommendation-agent.ts
import type { Book, FeedbackStats, RecommendationResult, RequirementAnalysis } from '@/lib/types/rag';
import { filterBlockedBooks } from '@/lib/server/book-filters';

function rankForBudget(
  book: Book,
  requirement: RequirementAnalysis,
  categoryWeight?: number,
  keywordWeight?: number
): number {
  let score = book.relevance_score ?? 0;
  const haystack = `${book.title} ${book.author} ${book.category} ${book.description}`.toLowerCase();

  const catW = categoryWeight !== undefined && categoryWeight !== null ? categoryWeight : 1.2;
  const keyW = keywordWeight !== undefined && keywordWeight !== null ? keywordWeight : 0.6;

  for (const category of requirement.categories) {
    if (haystack.includes(category.toLowerCase())) {
      score += catW;
    }
  }

  for (const keyword of requirement.keywords) {
    if (haystack.includes(keyword.toLowerCase())) {
      score += keyW;
    }
  }

  return score;
}

export function containsExcludedKeyword(book: Book, excludedKeywords: string[]): boolean {
  if (excludedKeywords.length === 0) {
    return false;
  }

  const haystack = `${book.title} ${book.author} ${book.category} ${book.description}`.toLowerCase();
  return excludedKeywords.some((keyword) => haystack.includes(keyword.toLowerCase()));
}

export function enforceBudget(
  books: Book[],
  requirement: RequirementAnalysis,
  categoryWeight?: number,
  keywordWeight?: number
): Book[] {
  const budget = requirement.constraints.budget;
  if (!budget || books.length === 0) {
    return books;
  }

  const affordable = books
    .filter((book) => book.price <= budget)
    .sort((a, b) => {
      const scoreA = rankForBudget(a, requirement, categoryWeight, keywordWeight);
      const scoreB = rankForBudget(b, requirement, categoryWeight, keywordWeight);
      const densityA = Math.max(0.1, scoreA) / Math.max(1, a.price);
      const densityB = Math.max(0.1, scoreB) / Math.max(1, b.price);
      return densityB - densityA;
    });

  const selected: Book[] = [];
  let total = 0;
  for (const book of affordable) {
    if (total + book.price > budget) {
      continue;
    }
    selected.push(book);
    total += book.price;
  }

  if (selected.length > 0) {
    return selected;
  }

  const cheapest = [...books].sort((a, b) => a.price - b.price)[0];
  return cheapest ? [cheapest] : [];
}

function enforceRecommendationConstraints(
  books: Book[],
  requirement: RequirementAnalysis,
  targetCount: number,
  categoryWeight?: number,
  keywordWeight?: number
): Book[] {
  const excludedKeywords = requirement.constraints.exclude_keywords ?? [];
  const withoutExcluded = books.filter((book) => !containsExcludedKeyword(book, excludedKeywords));
  const budgetSafe = enforceBudget(withoutExcluded, requirement, categoryWeight, keywordWeight);
  return budgetSafe.slice(0, Math.max(1, targetCount));
}

export function buildHeuristicExplanation(
  book: Book,
  requirement: RequirementAnalysis,
  feedbackStats?: FeedbackStats | null
): string {
  const haystack = `${book.title} ${book.category} ${book.description}`.toLowerCase();
  const matchedCategories = requirement.categories.filter((category) => haystack.includes(category.toLowerCase()));
  const matchedKeywords = requirement.keywords.filter((keyword) => keyword.length >= 2 && haystack.includes(keyword.toLowerCase())).slice(0, 3);
  const explanationParts: string[] = [];

  if (matchedCategories.length > 0) {
    explanationParts.push(`主题命中「${matchedCategories.join('、')}」`);
  }
  if (matchedKeywords.length > 0) {
    explanationParts.push(`关键词匹配「${matchedKeywords.join('、')}」`);
  }
  
  if (feedbackStats && feedbackStats.positiveCount > 0) {
    const total = feedbackStats.totalFeedback || (feedbackStats.positiveCount + feedbackStats.negativeCount);
    if (total > 0) {
      const approvalRate = Math.round((feedbackStats.positiveCount / total) * 100);
      explanationParts.push(`读者推荐度 ${approvalRate}%（${feedbackStats.positiveCount}位读者推荐）`);
    }
  }

  if (requirement.constraints.budget !== undefined) {
    const percent = Math.round((book.price / requirement.constraints.budget) * 100);
    explanationParts.push(`单本价格 ¥${book.price.toFixed(2)}（预算占比 ${percent}%）`);
  } else {
    explanationParts.push(`单本价格 ¥${book.price.toFixed(2)}`);
  }

  if (book.description) {
    const cleanDesc = book.description.replace(/\s+/g, ' ').trim();
    explanationParts.push(`简介: ${cleanDesc.length > 60 ? cleanDesc.slice(0, 60) + '...' : cleanDesc}`);
  }

  if (explanationParts.length === 0) {
    return '这本书与当前需求主题相关，且内容完整，适合作为候选。';
  }

  return `${explanationParts.join('；')}。`;
}

export async function generateRecommendation(
  requirement: RequirementAnalysis,
  candidates: Book[],
  weights?: { categoryWeight?: number; keywordWeight?: number }
): Promise<RecommendationResult> {
  const { books: visibleCandidates } = await filterBlockedBooks(candidates, requirement.inferred_library_type);

  const targetCount = Math.min(requirement.constraints.target_count ?? Math.min(5, visibleCandidates.length), visibleCandidates.length);

  if (visibleCandidates.length === 0) {
    return {
      books: [],
      total_price: 0,
      quality_score: 0,
      confidence: 0,
      category_distribution: {},
    };
  }

  const finalBooks = enforceRecommendationConstraints(
    visibleCandidates,
    requirement,
    targetCount,
    weights?.categoryWeight,
    weights?.keywordWeight
  );

  // Fetch feedback stats asynchronously for final selected books
  const { getFeedbackStats } = await import('@/lib/feedback/feedback-store');
  const { hasRedisConfig } = await import('@/lib/config/environment');
  const redisEnabled = hasRedisConfig();

  const mappedBooksPromise = finalBooks.map(async (book) => {
    let stats = null;
    if (redisEnabled) {
      try {
        stats = await getFeedbackStats(book.book_id);
      } catch (e) {
        console.warn(`[recommendation-agent] Failed to fetch feedback stats for ${book.book_id}:`, e);
      }
    }
    return {
      ...book,
      explanation: buildHeuristicExplanation(book, requirement, stats),
    };
  });

  const recommendedBooks = await Promise.all(mappedBooksPromise);

  const category_distribution: Record<string, number> = {};
  for (const book of recommendedBooks) {
    category_distribution[book.category] = (category_distribution[book.category] || 0) + 1;
  }

  const total_price = recommendedBooks.reduce((sum, book) => sum + book.price, 0);
  const coverage_score = recommendedBooks.length / visibleCandidates.length;

  const clarityScore = Math.min(1, (
    (requirement.categories.length + requirement.keywords.length + requirement.preferences.length) / 6
  ));
  const confidence = requirement.needs_clarification
    ? 0.3 + clarityScore * 0.2
    : 0.5 + clarityScore * 0.5;

  return {
    books: recommendedBooks,
    total_price,
    quality_score: coverage_score,
    confidence,
    category_distribution,
  };
}
