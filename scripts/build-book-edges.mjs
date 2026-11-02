#!/usr/bin/env node

/**
 * ADR-0004: Build the deterministic domain graph in `book_edges`.
 *
 * Edge types (zero LLM cost, derived from structured fields):
 *   same_author   1.0  exact author match (uncapped — authors have few books)
 *   same_clc      0.8  exact CLC code match, top 15 peers per node by popularity
 *   same_category 0.5  exact book_category match, top 20 peers per node
 *   same_age_band 0.4  overlapping age ranges, top 15 peers per node
 *   topic_entity  1.2  shared active filter_keywords hit on title/author, top 30
 *
 * All edges are stored symmetrically (a→b and b→a) so the query-side
 * recursive CTE only needs to follow from_book.
 *
 * Usage:
 *   Full rebuild:        node scripts/build-book-edges.mjs [--env-file .env.local]
 *   Incremental update:  node scripts/build-book-edges.mjs --book-ids 9787,9788
 *
 * Note: `same_series` from ADR-0004 is not built — the books table has no
 * series field yet; add an edge insert here when that field exists.
 */

import { createPool } from '@vercel/postgres';

import { loadEnvFile } from './lib/load-env.mjs';

const EDGE_SPECS = [
  {
    type: 'same_author',
    weight: 1.0,
    cap: 0, // uncapped
    condition: `a.author IS NOT NULL AND a.author <> ''`,
    match: 'b.author = a.author',
  },
  {
    type: 'same_clc',
    weight: 0.8,
    cap: 15,
    condition: `a.clc_code IS NOT NULL AND a.clc_code <> ''`,
    match: 'b.clc_code = a.clc_code',
  },
  {
    type: 'same_category',
    weight: 0.5,
    cap: 20,
    condition: `a.book_category IS NOT NULL AND a.book_category <> ''`,
    match: 'b.book_category = a.book_category',
  },
  {
    type: 'same_age_band',
    weight: 0.4,
    cap: 15,
    condition: `a.age_min IS NOT NULL AND a.age_max IS NOT NULL`,
    match: 'b.age_min IS NOT NULL AND b.age_max IS NOT NULL AND b.age_min <= a.age_max AND b.age_max >= a.age_min',
  },
];

const TOPIC_ENTITY_WEIGHT = 1.2;
const TOPIC_ENTITY_CAP = 30;
const MIN_KEYWORD_LENGTH = 2;

function parseArgs(argv) {
  const args = { envFile: '', bookIds: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--env-file') {
      args.envFile = argv[++i] ?? '';
    } else if (argv[i] === '--book-ids') {
      args.bookIds = String(argv[++i] ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);
    }
  }
  return args;
}

/** Forward structural edges: per-node top-K peers via lateral join. */
function buildStructuralEdgeInsert(spec, incremental) {
  const scopeClause = incremental ? 'AND a.id = ANY($1::bigint[])' : '';
  const capClause = spec.cap > 0
    ? `ORDER BY COALESCE(b.popularity_score, 0) DESC NULLS LAST, b.id LIMIT ${spec.cap}`
    : '';

  return `
    INSERT INTO book_edges (from_book, to_book, edge_type, weight)
    SELECT a.id, nb.id, '${spec.type}', ${spec.weight}
    FROM books a
    CROSS JOIN LATERAL (
      SELECT b.id
      FROM books b
      WHERE ${spec.match} AND b.id <> a.id
      ${capClause}
    ) nb
    WHERE ${spec.condition}
    ${scopeClause}
  `.replace(/\s+/g, ' ');
}

async function insertTopicEntityEdges(pool, incremental) {
  // topic_entity edges are always fully rebuilt: the keyword vocabulary is
  // small, so a full pass is cheap and keeps edges consistent.
  await pool.query(`DELETE FROM book_edges WHERE edge_type = 'topic_entity'`);

  const { rows: keywords } = await pool.query(
    `SELECT keyword FROM filter_keywords WHERE is_active = TRUE AND length(keyword) >= ${MIN_KEYWORD_LENGTH}`,
  );
  console.log(`🔗 topic_entity: ${keywords.length} active keywords`);

  let inserted = 0;
  for (const { keyword } of keywords) {
    const result = await pool.query(
      `
      WITH matched AS (
        SELECT id
        FROM books
        WHERE (title ILIKE '%' || $1 || '%' OR author ILIKE '%' || $1 || '%')
        ORDER BY COALESCE(popularity_score, 0) DESC NULLS LAST, id
        LIMIT ${TOPIC_ENTITY_CAP}
      )
      INSERT INTO book_edges (from_book, to_book, edge_type, weight)
      SELECT a.id, b.id, 'topic_entity', ${TOPIC_ENTITY_WEIGHT}
      FROM matched a
      CROSS JOIN matched b
      WHERE a.id < b.id
      `,
      [keyword],
    );
    inserted += result.rowCount ?? 0;
  }
  return inserted;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadEnvFile(args.envFile);

  const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error('Missing POSTGRES_URL or DATABASE_URL');

  const incremental = args.bookIds.length > 0;
  const pool = createPool({ connectionString });

  // All mutations run in one transaction so an auto-triggered rebuild is
  // atomic — graph queries never observe a half-rebuilt edge set.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: tableCheck } = await client.query(
      `SELECT to_regclass('public.book_edges') IS NOT NULL AS ready`,
    );
    if (!tableCheck[0]?.ready) {
      throw new Error('book_edges table missing — run `node scripts/vercel/init-db.mjs` first');
    }

    if (incremental) {
      console.log(`🔄 Incremental rebuild for ${args.bookIds.length} books`);
      await client.query(
        `DELETE FROM book_edges WHERE from_book = ANY($1::bigint[]) OR to_book = ANY($1::bigint[])`,
        [args.bookIds],
      );
    } else {
      console.log('🔄 Full rebuild: truncating book_edges');
      await client.query('TRUNCATE book_edges');
    }

    let structural = 0;
    for (const spec of EDGE_SPECS) {
      const insertSql = buildStructuralEdgeInsert(spec, incremental);
      const result = await client.query(insertSql, incremental ? [args.bookIds] : []);
      structural += result.rowCount ?? 0;
      console.log(`✅ ${spec.type}: +${result.rowCount ?? 0} edges (weight ${spec.weight})`);
    }

    const topic = await insertTopicEntityEdges(client, incremental);
    console.log(`✅ topic_entity: +${topic} edges (weight ${TOPIC_ENTITY_WEIGHT})`);

    // Symmetrize: mirror every edge so from_book/to_book both traverse.
    const mirrored = await client.query(
      `
      INSERT INTO book_edges (from_book, to_book, edge_type, weight)
      SELECT to_book, from_book, edge_type, weight
      FROM book_edges
      ON CONFLICT (from_book, to_book, edge_type) DO NOTHING
      `,
    );
    console.log(`🔁 Symmetrized: +${mirrored.rowCount ?? 0} mirrored edges`);

    const { rows: totals } = await client.query(
      `SELECT edge_type, COUNT(*)::int AS edges FROM book_edges GROUP BY edge_type ORDER BY edge_type`,
    );
    await client.query('COMMIT');
    for (const row of totals) {
      console.log(`   ${row.edge_type}: ${row.edges}`);
    }
    console.log('\n✨ book_edges build complete.');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error('❌ book_edges build failed:', error.message);
  process.exitCode = 1;
});
