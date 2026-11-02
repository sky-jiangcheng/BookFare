#!/usr/bin/env node

/**
 * ADR-0002: Backfill book embeddings for semantic recall.
 *
 * Reads books whose `embedding` column is NULL, generates Gemini embeddings
 * (gemini-embedding-001, RETRIEVAL_DOCUMENT task type) and writes them back to
 * `books.embedding`. Safe to re-run; incremental by design.
 *
 * The embedding dimension is taken from the `books.embedding` column itself, so
 * the vectors written here always match the column. `--dimensions` is only
 * accepted when it agrees with the column.
 *
 * Usage:
 *   node scripts/backfill-embeddings.mjs [--env-file .env.local] \
 *     [--batch-size 32] [--limit 0] [--model gemini-embedding-001] [--dimensions N]
 *
 * Requires: GOOGLE_API_KEY, POSTGRES_URL (or DATABASE_URL).
 */

import { createPool } from '@vercel/postgres';

import { assertEmbeddingDimension, parseVectorColumnDimension } from '../lib/embedding-dimension.mjs';
import { loadEnvFile } from './lib/load-env.mjs';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MAX_BATCH_SIZE = 100;
const DESCRIPTION_SNIPPET_LENGTH = 1200;

function parseArgs(argv) {
  const args = {
    envFile: '',
    batchSize: 32,
    limit: 0,
    model: 'gemini-embedding-001',
    dimensions: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case '--env-file':
        args.envFile = argv[++i] ?? '';
        break;
      case '--batch-size':
        args.batchSize = Number(argv[++i]);
        break;
      case '--limit':
        args.limit = Number(argv[++i]);
        break;
      case '--model':
        args.model = argv[++i];
        break;
      case '--dimensions':
        args.dimensions = Number(argv[++i]);
        break;
      default:
        break;
    }
  }

  if (!Number.isInteger(args.batchSize) || args.batchSize < 1 || args.batchSize > MAX_BATCH_SIZE) {
    throw new Error(`--batch-size must be between 1 and ${MAX_BATCH_SIZE}`);
  }
  if (!Number.isInteger(args.limit) || args.limit < 0) {
    throw new Error('--limit must be a non-negative integer (0 = all)');
  }
  if (args.dimensions !== null && (!Number.isInteger(args.dimensions) || args.dimensions < 1)) {
    throw new Error('--dimensions must be a positive integer');
  }
  return args;
}

/**
 * Dimension of the `books.embedding` column, or null when the column is
 * missing or is not a dimensioned vector column.
 */
async function readEmbeddingColumnDimension(pool) {
  const result = await pool.query(
    `
      SELECT format_type(a.atttypid, a.atttypmod) AS column_type
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = 'books'
        AND a.attname = 'embedding'
        AND a.attnum > 0
        AND NOT a.attisdropped
    `,
  );
  return parseVectorColumnDimension(result.rows[0]?.column_type);
}

/** Document text fed to the embedding model: title + author + category + description snippet. */
function buildEmbeddingText(book) {
  const parts = [
    book.title,
    book.author,
    book.book_category,
    book.description ? String(book.description).slice(0, DESCRIPTION_SNIPPET_LENGTH) : '',
  ];
  return parts.filter(Boolean).join(' ');
}

async function batchEmbedContents(texts, { apiKey, model, dimensions }) {
  const response = await fetch(`${API_BASE}/models/${model}:batchEmbedContents`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      requests: texts.map((text) => ({
        model: `models/${model}`,
        content: { parts: [{ text }] },
        taskType: 'RETRIEVAL_DOCUMENT',
        outputDimensionality: dimensions,
      })),
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Gemini embedding API failed (${response.status}): ${detail.slice(0, 300)}`);
  }

  const payload = await response.json();
  const embeddings = payload?.embeddings;
  if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
    throw new Error(`Embedding count mismatch: sent ${texts.length}, got ${embeddings?.length ?? 0}`);
  }
  return embeddings.map((entry) => entry.values);
}

async function fetchPendingBatch(pool, { batchSize }) {
  const result = await pool.query(
    `
      SELECT
        b.id,
        b.title,
        b.author,
        b.book_category,
        bd.description
      FROM books b
      LEFT JOIN book_descriptions bd ON bd.book_id = b.id
      WHERE b.embedding IS NULL
      ORDER BY COALESCE(b.popularity_score, 0) DESC, b.id ASC
      LIMIT ${batchSize}
    `,
  );
  return result.rows;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadEnvFile(args.envFile);

  const apiKey = process.env.GOOGLE_API_KEY;
  const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;
  if (!apiKey) throw new Error('Missing GOOGLE_API_KEY');
  if (!connectionString) throw new Error('Missing POSTGRES_URL or DATABASE_URL');

  const pool = createPool({ connectionString });

  try {
    // The column decides the dimension — never the environment. Writing a
    // vector whose length differs from the column is what breaks recall.
    const columnDimension = await readEmbeddingColumnDimension(pool);
    if (columnDimension === null) {
      throw new Error(
        'books.embedding column missing or not dimensioned — run `node scripts/vercel/init-db.mjs` first',
      );
    }
    if (args.dimensions !== null && args.dimensions !== columnDimension) {
      throw new Error(
        `--dimensions ${args.dimensions} does not match the books.embedding column dimension (${columnDimension}).`,
      );
    }
    const dimensions = columnDimension;
    console.log(`📐 Embedding dimension: ${dimensions} (from books.embedding)`);

    const { rows: countRows } = await pool.query(
      'SELECT COUNT(*)::int AS pending FROM books WHERE embedding IS NULL',
    );
    const pendingTotal = countRows[0]?.pending ?? 0;
    console.log(`📚 Books pending embedding: ${pendingTotal}`);

    let processed = 0;
    let budget = args.limit > 0 ? args.limit : Infinity;

    while (budget > 0) {
      const batchSize = Math.min(args.batchSize, budget === Infinity ? args.batchSize : budget);
      const books = await fetchPendingBatch(pool, { batchSize });
      if (books.length === 0) break;

      const texts = books.map(buildEmbeddingText);
      const vectors = await batchEmbedContents(texts, {
        apiKey,
        model: args.model,
        dimensions,
      });

      for (let i = 0; i < books.length; i += 1) {
        assertEmbeddingDimension(vectors[i], dimensions);
        const literal = `[${vectors[i].join(',')}]`;
        await pool.query('UPDATE books SET embedding = $1::vector, updated_at = NOW() WHERE id = $2', [
          literal,
          String(books[i].id),
        ]);
      }

      processed += books.length;
      if (budget !== Infinity) budget -= books.length;
      console.log(`✅ Embedded ${processed}/${pendingTotal} books`);
    }

    console.log(`\n✨ Embedding backfill complete: ${processed} books processed.`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('❌ Embedding backfill failed:', error.message);
  process.exitCode = 1;
});
