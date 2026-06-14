import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applySimpleRerank } from '../lib/server/catalog-repository';
import type { Book, CatalogSearchFilters, RequirementAnalysis } from '../lib/types/rag';

function makeBook(overrides: Partial<Book>): Book {
  return {
    book_id: '1',
    title: '',
    author: '',
    category: '',
    description: '',
    publisher: '',
    publication_year: null,
    cover_url: null,
    price: 0,
    stock: null,
    book_category: '',
    library_codes: [],
    popularity_score: 0,
    clc_code: '',
    age_min: null,
    age_max: null,
    ...overrides,
  } as Book;
}

/** Build a valid RequirementAnalysis with only the fields relevant to reranking. */
function makeRequirement(
  overrides: Partial<RequirementAnalysis> = {},
): RequirementAnalysis {
  return {
    original_query: '历史',
    categories: ['历史'],
    keywords: ['历史'],
    expanded_search_terms: ['历史'],
    constraints: {},
    preferences: [],
    needs_clarification: false,
    clarification_questions: [],
    ...overrides,
  };
}

const baseFilters: CatalogSearchFilters = {
  query: '历史',
  search_terms: ['历史'],
};

test('applySimpleRerank ranks title matches above category matches', () => {
  const books = [
    // "历史" appears in the title → +3.5 (title branch wins, category skipped).
    makeBook({ book_id: '1', title: '历史教材', category: '历史' }),
    // "历史" only appears in the category → +2.6.
    makeBook({ book_id: '2', title: '中国通史', category: '历史' }),
  ];

  const ranked = applySimpleRerank(books, baseFilters, ['历史'], {});

  assert.equal(ranked[0].book_id, '1');
  assert.equal(ranked[1].book_id, '2');
  assert.ok(ranked[0].relevance_score! > ranked[1].relevance_score!);
});

test('applySimpleRerank applies exclusion keyword penalty (−10)', () => {
  const filters: CatalogSearchFilters = {
    ...baseFilters,
    requirement: makeRequirement({
      constraints: { exclude_keywords: ['教材', '教辅'] },
    }),
  };

  const books = [
    makeBook({ book_id: '1', title: '历史故事', category: '历史' }),
    makeBook({ book_id: '2', title: '历史教材', category: '历史' }), // 命中排除词"教材"
  ];

  const ranked = applySimpleRerank(books, filters, ['历史'], {});

  // Book 2 hits the title keyword AND an exclusion keyword. Without the
  // −10 penalty it would tie or beat book 1; with the penalty it must drop.
  assert.equal(ranked[0].book_id, '1');
  assert.equal(ranked[1].book_id, '2');
  assert.ok(ranked[0].relevance_score! > ranked[1].relevance_score!);
  // The penalty is large enough to make an otherwise-strong match negative.
  assert.ok(ranked[1].relevance_score! < ranked[0].relevance_score! - 5);
});

test('applySimpleRerank skips exclusion penalty when no exclusion keywords set', () => {
  // No requirement → no exclusion keywords → no penalty applied regardless of
  // whether a book happens to contain words that *would* be excluded.
  // Both books have "历史" in the title so they tie on field score.
  const books = [
    makeBook({ book_id: '1', title: '历史故事', category: '历史' }),
    makeBook({ book_id: '2', title: '历史教材', category: '历史' }),
  ];

  const ranked = applySimpleRerank(books, baseFilters, ['历史'], {});

  const book1 = ranked.find((b) => b.book_id === '1')!;
  const book2 = ranked.find((b) => b.book_id === '2')!;
  assert.equal(book1.relevance_score, book2.relevance_score);
});

test('applySimpleRerank boosts age-appropriate books for 小学 library type (+3.0)', () => {
  const filters: CatalogSearchFilters = {
    ...baseFilters,
    requirement: makeRequirement({
      original_query: '科普',
      categories: ['科普'],
      keywords: ['科普'],
      expanded_search_terms: ['科普'],
      inferred_library_type: '小学',
    }),
  };

  const books = [
    makeBook({ book_id: '1', title: '少儿科普', category: '科普', age_min: 6, age_max: 12 }),
    makeBook({ book_id: '2', title: '高级科普', category: '科普', age_min: 16, age_max: 30 }),
  ];

  const ranked = applySimpleRerank(books, filters, ['科普'], {});

  // Both books match identically on title/category; the age-fit book (6-12,
  // overlaps 小学's 6-12 band) gets +3.0 while the off-target book gets −3.0.
  assert.equal(ranked[0].book_id, '1');
  assert.equal(ranked[1].book_id, '2');
  // Net difference is ~6.0 (the swing between +3 and −3).
  assert.ok(ranked[0].relevance_score! - ranked[1].relevance_score! > 5);
});

test('applySimpleRerank boosts age-appropriate books for 初高中 library type', () => {
  const filters: CatalogSearchFilters = {
    ...baseFilters,
    requirement: makeRequirement({
      original_query: '科普',
      categories: ['科普'],
      keywords: ['科普'],
      expanded_search_terms: ['科普'],
      inferred_library_type: '初高中',
    }),
  };

  const books = [
    makeBook({ book_id: '1', title: '青少年科普', category: '科普', age_min: 12, age_max: 18 }),
    makeBook({ book_id: '2', title: '幼儿科普', category: '科普', age_min: 3, age_max: 6 }),
  ];

  const ranked = applySimpleRerank(books, filters, ['科普'], {});

  // 初高中 band is 12-18; book 1 fits (+3.0), book 2 (3-6) does not (−3.0).
  assert.equal(ranked[0].book_id, '1');
  assert.equal(ranked[1].book_id, '2');
});

test('applySimpleRerank leaves score unchanged for books with missing age range', () => {
  const filters: CatalogSearchFilters = {
    ...baseFilters,
    requirement: makeRequirement({
      original_query: '科普',
      categories: ['科普'],
      keywords: ['科普'],
      expanded_search_terms: ['科普'],
      inferred_library_type: '小学',
    }),
  };

  const books = [
    makeBook({ book_id: '1', title: '科普读物', category: '科普' }), // age_min/max are null
  ];

  const ranked = applySimpleRerank(books, filters, ['科普'], {});

  // No age data → age fit logic is skipped entirely. Score equals the
  // field-hit-only score: title "科普读物" matches "科普" → +3.5 (title branch
  // wins, category skipped). Popularity is 0 so contributes nothing.
  assert.equal(ranked[0].book_id, '1');
  assert.ok(Math.abs(ranked[0].relevance_score! - 3.5) < 0.01);
});
