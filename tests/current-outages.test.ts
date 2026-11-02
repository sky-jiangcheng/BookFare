import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const readSource = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('category mapping rounds REAL confidence through numeric', async () => {
  const source = await readSource('app/api/admin/category-mapping/route.ts');

  assert.doesNotMatch(source, /ROUND\(cm\.confidence,\s*4\)/);
  assert.match(source, /ROUND\(cm\.confidence::numeric,\s*4\)/);
});

test('category quality uses valid grouped aggregation queries', async () => {
  const source = await readSource('app/api/admin/category-quality/route.ts');

  assert.doesNotMatch(source, /ARRAY_AGG\(DISTINCT lt ORDER BY COUNT\(\*\) DESC\)/);
  assert.match(source, /GROUP BY split_part\(b\.book_category, '\/', 2\),\s*lt/);
  assert.match(source, /GROUP BY split_part\(books\.book_category, '\/', 2\),\s*books\.library_codes/);
});

test('chat keeps local and remote session identifiers separate', async () => {
  // SessionItem lives in rag-chat-utils.ts and is consumed by rag-chat.tsx;
  // the contract we guard is that local id and remoteSessionId stay distinct.
  const source = await readSource('components/rag-chat-utils.ts');

  assert.match(source, /remoteSessionId\?: string/);
  const chatSource = await readSource('components/rag-chat.tsx');
  assert.doesNotMatch(chatSource, /return \{ \.\.\.s, id: data\.sessionId \}/);
  assert.doesNotMatch(chatSource, /setActiveSessionId\(data\.sessionId\)/);
});

test('catalog search applies publication year as a parameterized filter', async () => {
  // The WHERE builder (buildFilterConditions, shared by the keyword and the
  // vector recall channels) advances a shared `paramIdx` counter for each
  // placeholder. Both the min and max year bounds must be parameterized
  // (not string-interpolated).
  const source = await readSource('lib/search/catalog-query.ts');

  assert.match(source, /publication_year >= \$\$\{paramIdx\+\+\}/);
  assert.match(source, /publication_year <= \$\$\{paramIdx\+\+\}/);
});
