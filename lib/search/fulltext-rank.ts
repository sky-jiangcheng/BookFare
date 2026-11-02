/**
 * ADR-0003: PG native tsvector full-text ranking helpers.
 *
 * Pure functions only — building the `to_tsquery` expression from the
 * segmented search terms and normalizing `ts_rank_cd` scores across the
 * candidate pool — so the logic is unit-testable without a database.
 *
 * Note on tokenization: the `simple` config splits contiguous CJK runs into
 * per-character tokens, so each term is rendered as a `<->` phrase query over
 * its characters (e.g. 亲子 → '亲' <-> '子'). ASCII runs stay single tokens.
 */

/** Upper bound on OR'd terms to keep the tsquery (and planner) sane. */
const MAX_TSQUERY_TERMS = 20;

/** Extract tsquery lexemes from one search term. */
function termToLexemes(term: string): string[] {
  return term.match(/[\p{Script=Han}]|[\p{L}\p{N}]+/gu) ?? [];
}

function quoteLexeme(lexeme: string): string {
  return `'${lexeme.replace(/'/g, '')}'`;
}

/**
 * Build the text of a `to_tsquery('simple', ...)` expression from segmented
 * search terms. Terms are OR'd; each term becomes a `<->` phrase over its
 * lexemes. Returns null when no term yields a usable lexeme.
 */
export function buildTsQueryExpression(rawTerms: string[]): string | null {
  const expressions: string[] = [];

  for (const rawTerm of rawTerms) {
    if (expressions.length >= MAX_TSQUERY_TERMS) break;
    const lexemes = termToLexemes(rawTerm.trim());
    if (lexemes.length === 0) continue;
    expressions.push(lexemes.map(quoteLexeme).join(' <-> '));
  }

  return expressions.length > 0 ? expressions.join(' | ') : null;
}

export interface FtsScoreInput {
  bookId: string;
  raw: number;
}

/**
 * Normalize raw ts_rank_cd scores into [0, 1] relative to the best candidate
 * in the pool. Books without a row (or a zero max) get 0.
 */
export function normalizeFtsScores(entries: FtsScoreInput[]): Map<string, number> {
  const normalized = new Map<string, number>();
  let max = 0;
  for (const entry of entries) {
    const raw = Number(entry.raw);
    if (Number.isFinite(raw) && raw > max) {
      max = raw;
    }
  }
  if (max <= 0) {
    return normalized;
  }
  for (const entry of entries) {
    const raw = Number(entry.raw);
    if (Number.isFinite(raw) && raw > 0) {
      normalized.set(entry.bookId, Math.min(1, raw / max));
    }
  }
  return normalized;
}
