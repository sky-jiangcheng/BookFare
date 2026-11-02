import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildGraphNeighborQuery,
  computeGraphScores,
  mergeGraphNeighbors,
} from '../lib/search/graph-recall';
import { rerankCatalogBooks } from '../lib/search/query-rerank';
import type { Book } from '../lib/types/rag';

function makeBook(id: string, overrides: Partial<Book> = {}): Book {
  return {
    book_id: id,
    title: `书 ${id}`,
    author: '作者',
    publisher: '出版社',
    price: 30,
    stock: 5,
    category: '文学',
    description: '',
    relevance_score: 0,
    ...overrides,
  };
}

test('buildGraphNeighborQuery builds bounded recursive CTE', () => {
  const { sql, params } = buildGraphNeighborQuery(['1', '2'], { depth: 2, limit: 100 });

  assert.match(sql, /WITH RECURSIVE walk AS/);
  assert.match(sql, /WHERE e\.from_book = ANY\(\$1::bigint\[\]\)/);
  assert.match(sql, /WHERE w\.depth < \$2/);
  assert.match(sql, /UNION\n/); // plain UNION so cycles terminate
  assert.match(sql, /LIMIT 100/);
  assert.deepEqual(params, [['1', '2'], 2]);
});

test('buildGraphNeighborQuery clamps depth to [1, 3]', () => {
  assert.deepEqual(buildGraphNeighborQuery(['1'], { depth: 0 }).params, [['1'], 1]);
  assert.deepEqual(buildGraphNeighborQuery(['1'], { depth: 9 }).params, [['1'], 3]);
});

test('computeGraphScores scales by hop depth and keeps the max per book', () => {
  const scores = computeGraphScores([
    { book_id: '10', depth: 1, weight: 1.2 },
    { book_id: '11', depth: 2, weight: 0.8 },
    { book_id: '12', depth: 1, weight: 0.5 },
    { book_id: '12', depth: 2, weight: 0.9 }, // 0.9 < 1.0, must not beat the 1-hop score
    { book_id: '13', depth: 2, weight: -1 }, // invalid, dropped
  ]);

  assert.ok(Math.abs(scores.get('10')! - 2.4) < 1e-9);
  assert.ok(Math.abs(scores.get('11')! - 0.8) < 1e-9);
  assert.ok(Math.abs(scores.get('12')! - 1.0) < 1e-9);
  assert.equal(scores.has('13'), false);
});

test('mergeGraphNeighbors annotates pool members and appends new neighbors', () => {
  const pool = [makeBook('1'), makeBook('2')];
  const neighbors = [makeBook('2', { title: '重复（不应追加）' }), makeBook('3')];
  const scores = new Map([['2', 2.0], ['3', 1.0]]);

  const merged = mergeGraphNeighbors(pool, neighbors, scores);

  assert.deepEqual(merged.map((b) => b.book_id), ['1', '2', '3']);
  assert.equal(merged[0].graph_score, undefined);
  assert.equal(merged[1].graph_score, 2.0);
  assert.equal(merged[2].graph_score, 1.0);
  assert.equal(merged[2].title, '书 3');
});

test('graph_score lifts neighbors in the rerank', async () => {
  const ranked = await rerankCatalogBooks(
    [
      makeBook('1', { title: '完全无关的书' }),
      makeBook('2', { title: '另一本无关的书', graph_score: 2.4 }),
    ],
    '某个主题',
  );
  assert.equal(ranked[0].book_id, '2');
});
