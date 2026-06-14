import 'server-only';

import { redis } from '@/lib/upstash';
import type { BookListParseSession } from '@/lib/book-list/types';
import { REDIS_KEYS, TTL } from '@/lib/utils/redis-keys';

// ── Postgres fallback (only available when POSTGRES_URL is set) ──

let sql: typeof import('@vercel/postgres').sql | null = null;
try {
  if (process.env.POSTGRES_URL) {
    // Dynamic import keeps @vercel/postgres optional (it may be absent when
    // POSTGRES_URL is unset and the memory/Redis fallbacks are in use).
    const postgresModule = await import('@vercel/postgres');
    sql = postgresModule.sql;
  }
} catch (error) {
  // @vercel/postgres not installed or unavailable — fall through to memory.
  console.warn('[session-store] @vercel/postgres unavailable, using memory fallback:', error);
}

let tableEnsured = false;

async function ensureSessionTable(): Promise<void> {
  if (tableEnsured || !sql) return;
  await sql`
    CREATE TABLE IF NOT EXISTS booklist_sessions (
      id        TEXT PRIMARY KEY,
      data      JSONB NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    )
  `;
  tableEnsured = true;
}

// ── Memory fallback (last resort) ──

const memoryFallback = new Map<string, BookListParseSession>();

export async function saveBookListParseSession(
  requestId: string,
  session: BookListParseSession,
): Promise<void> {
  if (redis) {
    await redis.set(REDIS_KEYS.booklistSession(requestId), JSON.stringify(session), { ex: TTL.SESSION });
    return;
  }

  if (sql) {
    await ensureSessionTable();
    const expiresAt = new Date(Date.now() + TTL.SESSION * 1000).toISOString();
    await sql`
      INSERT INTO booklist_sessions (id, data, expires_at)
      VALUES (${requestId}, ${JSON.stringify(session)}, ${expiresAt})
      ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, expires_at = EXCLUDED.expires_at
    `;
    return;
  }

  memoryFallback.set(requestId, session);
  if (memoryFallback.size > 5000) {
    const first = memoryFallback.keys().next().value;
    if (first) memoryFallback.delete(first);
  }
}

export async function getBookListParseSession(
  requestId: string,
): Promise<BookListParseSession | null> {
  if (redis) {
    const raw = await redis.get<string>(REDIS_KEYS.booklistSession(requestId));
    if (!raw || typeof raw !== 'string') {
      return null;
    }
    try {
      return JSON.parse(raw) as BookListParseSession;
    } catch {
      return null;
    }
  }

  if (sql) {
    await ensureSessionTable();
    const row = await sql`
      SELECT data FROM booklist_sessions
      WHERE id = ${requestId} AND expires_at > NOW()
    `;
    if (row.rows.length === 0) return null;
    try {
      return row.rows[0].data as BookListParseSession;
    } catch {
      return null;
    }
  }

  return memoryFallback.get(requestId) ?? null;
}
