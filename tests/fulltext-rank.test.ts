import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTsQueryExpression, normalizeFtsScores } from '../lib/search/fulltext-rank';
import { rerankCatalogBooks } from '../lib/search/query-rerank';
import type { Book } from '../lib/types/rag';

test('buildTsQueryExpression renders CJK terms as phrase queries', () => {
  const expr = buildTsQueryExpression(['亲子共读']);
  assert.equal(expr, `'亲' <-> '子' <-> '共' <-> '读'`);
});

test('buildTsQueryExpression ORs multiple terms and keeps ASCII as single lexemes', () => {
  const expr = buildTsQueryExpression(['围棋', 'python']);
  assert.equal(expr, `'围' <-> '棋' | 'python'`);
});

test('buildTsQueryExpression strips tsquery-breaking quotes and skips empty terms', () => {
  const expr = buildTsQueryExpression(["  '健'康  ", '   ', '']);
  assert.equal(expr, `'健' <-> '康'`);
});

test('buildTsQueryExpression caps the number of OR terms', () => {
  const terms = Array.from({ length: 30 }, (_, i) => `词${i}`);
  const expr = buildTsQueryExpression(terms);
  assert.equal(expr?.split(' | ').length, 20);
});

test('buildTsQueryExpression returns null when nothing usable remains', () => {
  assert.equal(buildTsQueryExpression([]), null);
  assert.equal(buildTsQueryExpression(['', '   ']), null);
});

test('normalizeFtsScores scales by the pool maximum and clamps to [0, 1]', () => {
  const scores = normalizeFtsScores([
    { bookId: '1', raw: 0.08 },
    { bookId: '2', raw: 0.02 },
    { bookId: '3', raw: 0 },
  ]);
  assert.equal(scores.get('1'), 1);
  assert.ok(Math.abs(scores.get('2')! - 0.25) < 1e-9);
  assert.equal(scores.has('3'), false);
});

test('normalizeFtsScores returns empty map for zero/invalid input', () => {
  assert.equal(normalizeFtsScores([]).size, 0);
  assert.equal(normalizeFtsScores([{ bookId: '1', raw: 0 }]).size, 0);
  assert.equal(normalizeFtsScores([{ bookId: '1', raw: Number.NaN }]).size, 0);
});

function makeBook(overrides: Partial<Book>): Book {
  return {
    book_id: '1',
    title: '普通书',
    author: '张三',
    publisher: '某出版社',
    price: 50,
    stock: 10,
    category: '文学',
    description: '',
    relevance_score: 0,
    ...overrides,
  };
}

test('rerank boosts books carrying a full-strength fts_score', async () => {
  // Book 2 has no manual-rule advantage; only its fts_score differs.
  const ranked = await rerankCatalogBooks(
    [
      makeBook({ book_id: '1', title: '都市生活札记' }),
      makeBook({ book_id: '2', title: '围棋定式大全', fts_score: 1 }),
    ],
    '围棋',
  );
  assert.equal(ranked[0].book_id, '2');
});

test('rerank prefers the higher of two fts_scores', async () => {
  const ranked = await rerankCatalogBooks(
    [
      makeBook({ book_id: '1', title: '围棋入门', fts_score: 0.4 }),
      makeBook({ book_id: '2', title: '围棋进阶', fts_score: 0.8 }),
    ],
    '围棋',
  );
  assert.equal(ranked[0].book_id, '2');
});
