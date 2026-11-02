#!/usr/bin/env node

/**
 * Initialize BookStore database schema on Vercel Postgres
 * Usage: node scripts/vercel/init-db.mjs
 */

import { sql } from '@vercel/postgres';

import { parseVectorColumnDimension, resolveEmbeddingDimensions } from '../../lib/embedding-dimension.mjs';

console.log('🚀 Initializing BookStore database schema...\n');

// Check for --drop flag to allow table reset
const shouldDrop = process.argv.includes('--drop');
// Check for --fix-dimension flag to allow migrating an existing embedding column
const shouldFixDimension = process.argv.includes('--fix-dimension');

/**
 * Current dimension of the `books.embedding` column, or null when the column
 * does not exist yet (or is not a dimensioned vector column).
 */
async function readEmbeddingColumnDimension() {
  const { rows } = await sql`
    SELECT format_type(a.atttypid, a.atttypmod) AS column_type
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'books'
      AND a.attname = 'embedding'
      AND a.attnum > 0
      AND NOT a.attisdropped
  `;
  return parseVectorColumnDimension(rows[0]?.column_type);
}

if (shouldDrop) {
  // WARNING: This will permanently delete all data in the books table!
  console.warn('⚠️  WARNING: --drop flag detected. This will DELETE all existing data!');
  console.warn('⚠️  Press Ctrl+C within 3 seconds to cancel...\n');
  await new Promise(resolve => setTimeout(resolve, 3000));
}

try {
  // Drop existing table only if --drop flag is provided
  if (shouldDrop) {
    await sql`DROP TABLE IF EXISTS books CASCADE`;
    console.log('🔄 Dropped existing table for schema update');
  }

  // Create books table with bigint id and a nullable source_id for oversized source identifiers
  await sql`
    CREATE TABLE IF NOT EXISTS books (
      id BIGINT PRIMARY KEY,
      source_id TEXT,
      title VARCHAR(255) NOT NULL,
      author VARCHAR(255),
      publisher VARCHAR(255),
      publication_year SMALLINT CHECK (publication_year BETWEEN 1900 AND 2100),
      cover_url VARCHAR(512),
      price DECIMAL(10, 2),
      stock INTEGER DEFAULT 0,
      book_category VARCHAR(100),
      library_codes TEXT[] NOT NULL DEFAULT '{}',
      popularity_score DECIMAL(5, 2) DEFAULT 0,
      clc_code VARCHAR(50),
      age_min SMALLINT,
      age_max SMALLINT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `;
  console.log('✅ Created table: books (with BIGINT id and source_id)');

  // Create book_descriptions table for vertical partitioning
  await sql`
    CREATE TABLE IF NOT EXISTS book_descriptions (
      book_id BIGINT PRIMARY KEY,
      description TEXT
    )
  `;
  console.log('✅ Created table: book_descriptions');

  // Create indexes
  await sql`CREATE INDEX IF NOT EXISTS idx_books_title ON books(title)`;
  console.log('✅ Created index: idx_books_title');

  await sql`CREATE INDEX IF NOT EXISTS idx_books_author ON books(author)`;
  console.log('✅ Created index: idx_books_author');

  await sql`CREATE INDEX IF NOT EXISTS idx_books_category ON books(book_category)`;
  console.log('✅ Created index: idx_books_category');

  await sql`CREATE INDEX IF NOT EXISTS idx_books_popularity ON books(popularity_score DESC)`;
  console.log('✅ Created index: idx_books_popularity');

  await sql`
    CREATE INDEX IF NOT EXISTS idx_books_publication_year
    ON books(publication_year)
    WHERE publication_year IS NOT NULL
  `;
  console.log('✅ Created index: idx_books_publication_year');

  await sql`
    CREATE INDEX IF NOT EXISTS idx_books_clc_code
    ON books(clc_code)
    WHERE clc_code IS NOT NULL
  `;
  console.log('✅ Created index: idx_books_clc_code');

  await sql`
    CREATE INDEX IF NOT EXISTS idx_books_age_range
    ON books(age_min, age_max)
    WHERE age_min IS NOT NULL OR age_max IS NOT NULL
  `;
  console.log('✅ Created index: idx_books_age_range');

  await sql`
    CREATE INDEX IF NOT EXISTS idx_books_primary_category
    ON books (split_part(book_category, '/', 2))
  `;
  console.log('✅ Created index: idx_books_primary_category');

  // Optional trigram index for fast ILIKE and fuzzy text matching.
  try {
    await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`;
    await sql`
      CREATE INDEX IF NOT EXISTS idx_books_search_trgm
      ON books
      USING gin (
        (coalesce(title, '') || ' ' || coalesce(author, '') || ' ' || coalesce(book_category, '')) gin_trgm_ops
      )
    `;
    console.log('✅ Created index: idx_books_search_trgm');
  } catch (e) {
    console.log('⚠️  Trigram index skipped; keyword search will still work without it. Error:', e.message || e);
  }

  // --- ADR-0002: pgvector semantic recall column ---
  let vectorReady = false;
  try {
    await sql`CREATE EXTENSION IF NOT EXISTS vector`;
    vectorReady = true;
    console.log('✅ Created extension: vector');
  } catch (e) {
    console.log('⚠️  pgvector extension unavailable; semantic recall stays disabled. Error:', e.message || e);
  }

  if (vectorReady) {
    const desiredDimension = resolveEmbeddingDimensions();
    const existingDimension = await readEmbeddingColumnDimension();

    if (existingDimension === null) {
      // `sql` is a server-side parameterised template — a bind parameter is
      // not allowed in a type position, so the (validated integer) dimension
      // goes into the statement text itself.
      await sql.query(
        `ALTER TABLE books ADD COLUMN IF NOT EXISTS embedding vector(${desiredDimension})`,
      );
      console.log(`✅ Ensured column: books.embedding vector(${desiredDimension})`);
    } else if (existingDimension === desiredDimension) {
      console.log(`✅ Column already at vector(${desiredDimension})`);
    } else if (shouldFixDimension) {
      // pgvector has no cast between different dimensions, so the stored
      // vectors must be cleared before the column can be retyped.
      console.warn(
        `⚠️  Column is vector(${existingDimension}) but EMBEDDING_DIMENSIONS is ${desiredDimension} — migrating.`,
      );
      await sql`DROP INDEX IF EXISTS idx_books_embedding_hnsw`;
      console.log('🔄 Dropped index: idx_books_embedding_hnsw');
      await sql`UPDATE books SET embedding = NULL WHERE embedding IS NOT NULL`;
      console.log('🔄 Cleared stored embeddings (re-derivable by the backfill)');
      await sql.query(
        `ALTER TABLE books ALTER COLUMN embedding TYPE vector(${desiredDimension})`,
      );
      console.log(`✅ Migrated column: books.embedding → vector(${desiredDimension})`);
    } else {
      throw new Error(
        `books.embedding is vector(${existingDimension}) but EMBEDDING_DIMENSIONS is ${desiredDimension}. ` +
          'Run `node scripts/vercel/init-db.mjs --fix-dimension` to migrate the column, ' +
          'then re-run `npm run backfill:embeddings`.',
      );
    }

    try {
      await sql`
        CREATE INDEX IF NOT EXISTS idx_books_embedding_hnsw
        ON books USING hnsw (embedding vector_cosine_ops)
      `;
      console.log('✅ Created index: idx_books_embedding_hnsw');
    } catch (e) {
      console.log('⚠️  HNSW index skipped; sequential scan still works on small catalogs. Error:', e.message || e);
    }
  }

  // --- ADR-0003: native tsvector full-text ranking column ---
  await sql`
    ALTER TABLE books ADD COLUMN IF NOT EXISTS search_tsv tsvector
    GENERATED ALWAYS AS (
      to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(author, '') || ' ' || coalesce(book_category, ''))
    ) STORED
  `;
  console.log('✅ Ensured column: books.search_tsv (generated tsvector)');

  await sql`CREATE INDEX IF NOT EXISTS idx_books_search_tsv ON books USING gin (search_tsv)`;
  console.log('✅ Created index: idx_books_search_tsv');

  // --- ADR-0004: deterministic domain-graph edges ---
  await sql`
    CREATE TABLE IF NOT EXISTS book_edges (
      from_book BIGINT NOT NULL,
      to_book BIGINT NOT NULL,
      edge_type TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 1.0,
      PRIMARY KEY (from_book, to_book, edge_type)
    )
  `;
  console.log('✅ Created table: book_edges');

  await sql`CREATE INDEX IF NOT EXISTS idx_book_edges_from ON book_edges(from_book)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_book_edges_to ON book_edges(to_book)`;
  console.log('✅ Created indexes: idx_book_edges_from / idx_book_edges_to');

  console.log('\n✨ Schema initialization complete!\n');

} catch (error) {
  console.error('❌ Schema initialization failed:', error.message);
  process.exit(1);
}
