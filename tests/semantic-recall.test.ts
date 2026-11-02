import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildBatchEmbeddingRequest,
  chunkArray,
  embedTexts,
  parseBatchEmbeddingResponse,
  truncateEmbeddingText,
  vectorToPgLiteral,
} from '../lib/ai/embeddings';
import { buildVectorSearchQuery, mergeRecallPools } from '../lib/search/semantic-recall';
import type { Book, CatalogSearchFilters } from '../lib/types/rag';

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

test('chunkArray splits evenly and keeps remainder', () => {
  assert.deepEqual(chunkArray([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunkArray([], 3), []);
  assert.deepEqual(chunkArray([1, 2], 10), [[1, 2]]);
});

test('truncateEmbeddingText caps length', () => {
  assert.equal(truncateEmbeddingText('abc', 5), 'abc');
  assert.equal(truncateEmbeddingText('abcdef', 5), 'abcde');
});

test('buildBatchEmbeddingRequest uses document task type and dimensionality', () => {
  const body = buildBatchEmbeddingRequest(['a', 'b'], {
    model: 'gemini-embedding-001',
    dimensions: 768,
    taskType: 'RETRIEVAL_DOCUMENT',
  });
  assert.equal(body.requests.length, 2);
  assert.equal(body.requests[0].model, 'models/gemini-embedding-001');
  assert.equal(body.requests[0].content.parts[0].text, 'a');
  assert.equal(body.requests[0].taskType, 'RETRIEVAL_DOCUMENT');
  assert.equal(body.requests[0].outputDimensionality, 768);
});

test('parseBatchEmbeddingResponse extracts vectors and rejects malformed payloads', () => {
  const vectors = parseBatchEmbeddingResponse({ embeddings: [{ values: [0.1, 0.2] }, { values: [0.3] }] });
  assert.deepEqual(vectors, [[0.1, 0.2], [0.3]]);

  assert.throws(() => parseBatchEmbeddingResponse({}));
  assert.throws(() => parseBatchEmbeddingResponse({ embeddings: [{}, { values: [1] }] }));
});

test('vectorToPgLiteral renders pgvector text literal', () => {
  assert.equal(vectorToPgLiteral([0.1, 0.25, -1]), '[0.1,0.25,-1]');
  assert.equal(vectorToPgLiteral([]), '[]');
});

test('embedTexts batches requests and preserves order', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const body = JSON.parse(String(init.body));
    const embeddings = body.requests.map(() => ({ values: [0.5, 0.5] }));
    return new Response(JSON.stringify({ embeddings }), { status: 200 });
  }) as unknown as typeof fetch;

  const texts = Array.from({ length: 70 }, (_, i) => `book-${i}`);
  const vectors = await embedTexts(texts, {
    apiKey: 'test-key',
    model: 'gemini-embedding-001',
    dimensions: 768,
    taskType: 'RETRIEVAL_DOCUMENT',
    fetchImpl,
  });

  assert.equal(vectors.length, 70);
  assert.equal(calls.length, 3); // 32 + 32 + 6
  assert.match(calls[0].url, /batchEmbedContents$/);
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get('x-goog-api-key'), 'test-key');
});

test('embedTexts throws without API key', async () => {
  await assert.rejects(embedTexts(['x'], { apiKey: '' }), /GOOGLE_API_KEY/);
});

function makeFilters(overrides: Partial<CatalogSearchFilters> = {}): CatalogSearchFilters {
  return { query: '', ...overrides };
}

test('buildVectorSearchQuery applies hard filters but not keyword ILIKE', () => {
  const { sql, params } = buildVectorSearchQuery(
    makeFilters({ query: '鲁迅', categories: ['文学'], library_category: '小学' }),
    { topK: 50, startParamIndex: 2 },
  );

  assert.match(sql, /embedding IS NOT NULL/);
  assert.match(sql, /book_category IN \(\$2\)/);
  assert.match(sql, /library_codes @> ARRAY\[\$3\]::text\[\]/);
  assert.match(sql, /ORDER BY embedding <=> \$1::vector/);
  assert.match(sql, /LIMIT 50/);
  // Keyword text (鲁迅) must NOT leak into the vector channel.
  assert.doesNotMatch(sql, /ILIKE/);
  assert.equal(params.length, 2);
  assert.deepEqual(params, ['文学', '小学']);
});

test('mergeRecallPools dedups by book_id and keeps keyword-pool copies', () => {
  const keywordPool = [makeBook('1'), makeBook('2')];
  const vectorPool = [
    makeBook('2', { title: '重复书（应丢弃关键词池版本）' }),
    makeBook('3'),
  ];

  const merged = mergeRecallPools(keywordPool, vectorPool);
  assert.deepEqual(merged.map((b) => b.book_id), ['1', '2', '3']);
  assert.equal(merged[1].title, '书 2');
});

test('mergeRecallPools tolerates empty pools', () => {
  assert.deepEqual(mergeRecallPools([], []), []);
  assert.equal(mergeRecallPools([makeBook('1')], []).length, 1);
  assert.equal(mergeRecallPools([], [makeBook('1')]).length, 1);
});
