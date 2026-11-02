import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  assertEmbeddingDimension,
  DEFAULT_EMBEDDING_DIMENSIONS,
  parseVectorColumnDimension,
  resolveEmbeddingDimensions,
  SUPPORTED_EMBEDDING_DIMENSIONS,
} from '../lib/embedding-dimension.mjs';

const root = process.cwd();

test('resolveEmbeddingDimensions falls back to the canonical default', () => {
  assert.equal(DEFAULT_EMBEDDING_DIMENSIONS, 768);
  assert.equal(resolveEmbeddingDimensions({}), DEFAULT_EMBEDDING_DIMENSIONS);
  assert.equal(resolveEmbeddingDimensions({ EMBEDDING_DIMENSIONS: '' }), DEFAULT_EMBEDDING_DIMENSIONS);
});

test('resolveEmbeddingDimensions accepts every supported dimension', () => {
  assert.deepEqual(SUPPORTED_EMBEDDING_DIMENSIONS, [768, 1536, 3072]);
  for (const dimension of SUPPORTED_EMBEDDING_DIMENSIONS) {
    assert.equal(resolveEmbeddingDimensions({ EMBEDDING_DIMENSIONS: String(dimension) }), dimension);
  }
});

test('resolveEmbeddingDimensions rejects unsupported values instead of silently falling back', () => {
  assert.throws(() => resolveEmbeddingDimensions({ EMBEDDING_DIMENSIONS: 'abc' }), /EMBEDDING_DIMENSIONS/);
  assert.throws(() => resolveEmbeddingDimensions({ EMBEDDING_DIMENSIONS: '1024' }), /EMBEDDING_DIMENSIONS/);
  assert.throws(() => resolveEmbeddingDimensions({ EMBEDDING_DIMENSIONS: '1536.5' }), /EMBEDDING_DIMENSIONS/);
});

test('parseVectorColumnDimension reads the dimension out of a pgvector column type', () => {
  assert.equal(parseVectorColumnDimension('vector(768)'), 768);
  assert.equal(parseVectorColumnDimension('vector(1536)'), 1536);
  assert.equal(parseVectorColumnDimension('vector'), null);
  assert.equal(parseVectorColumnDimension('text'), null);
  assert.equal(parseVectorColumnDimension(undefined), null);
});

test('assertEmbeddingDimension catches the 1536-vs-768 mismatch before Postgres does', () => {
  const vector = new Array(768).fill(0.1);
  assert.equal(assertEmbeddingDimension(vector, 768), vector);

  assert.throws(() => assertEmbeddingDimension(new Array(1536).fill(0.1), 768), /expected 768, got 1536/);
  assert.throws(() => assertEmbeddingDimension(new Array(768).fill(0.1), 1536), /expected 1536, got 768/);
  assert.throws(() => assertEmbeddingDimension(null, 768), /dimension mismatch/);
});

// Every producer and consumer of an embedding must route through
// lib/embedding-dimension.mjs. A hard-coded dimension in any of them is how
// the runtime and the pgvector column drifted apart in the first place.
const DIMENSION_AWARE_FILES = [
  'lib/config/environment.ts',
  'lib/ai/embeddings.ts',
  'lib/server/catalog-repository.ts',
  'lib/server/embedding-dimension.ts',
  'scripts/vercel/init-db.mjs',
  'scripts/backfill-embeddings.mjs',
];

test('no embedding producer or consumer hard-codes a vector dimension', () => {
  for (const path of DIMENSION_AWARE_FILES) {
    const source = readFileSync(resolve(root, path), 'utf8');
    assert.match(
      source,
      /embedding-dimension\.mjs/,
      `${path} must import the shared dimension module`,
    );
    assert.doesNotMatch(
      source,
      /\b768\b|\b1536\b|\b3072\b/,
      `${path} must not hard-code a vector dimension`,
    );
  }
});

test('the runtime embeds queries at the dimension the column actually uses', () => {
  const source = readFileSync(resolve(root, 'lib/server/catalog-repository.ts'), 'utf8');
  assert.match(source, /getStoredEmbeddingDimension\(\)/);
  assert.match(source, /embedQueryText\(queryText, \{ dimensions: dimension \}\)/);
});

test('the backfill script derives its dimension from the column, not the environment', () => {
  const source = readFileSync(resolve(root, 'scripts/backfill-embeddings.mjs'), 'utf8');
  assert.match(source, /readEmbeddingColumnDimension/);
  assert.doesNotMatch(source, /EMBEDDING_DIMENSIONS/);
});

test('the schema script can detect and migrate a mismatched column', () => {
  const source = readFileSync(resolve(root, 'scripts/vercel/init-db.mjs'), 'utf8');
  assert.match(source, /--fix-dimension/);
  assert.match(source, /readEmbeddingColumnDimension/);
  assert.match(source, /ALTER COLUMN embedding TYPE vector/);
});

test('the schema DDL never puts a bind parameter in a type position', () => {
  const source = readFileSync(resolve(root, 'scripts/vercel/init-db.mjs'), 'utf8');
  // `sql` is a server-side parameterised template, so an interpolated value
  // becomes `$1` — and `vector($1)` is a syntax error. The dimension must go
  // through `sql.query` instead.
  assert.doesNotMatch(source, /sql`[^`]*\$\{/s);
  assert.match(
    source,
    /sql\.query\([^)]*ALTER TABLE books ADD COLUMN IF NOT EXISTS embedding vector\(\$\{desiredDimension\}\)/,
  );
  assert.match(
    source,
    /sql\.query\([^)]*ALTER TABLE books ALTER COLUMN embedding TYPE vector\(\$\{desiredDimension\}\)/,
  );
});
