import { NextResponse } from 'next/server';

import {
  hasDatabaseConfig,
  hasRedisConfig,
} from '@/lib/config/environment';

export async function GET() {
  const database = hasDatabaseConfig();
  const redis = hasRedisConfig();

  const requiredDepsMet = database;
  const status = requiredDepsMet ? 'ok' : 'degraded';

  return NextResponse.json({
    status,
    healthy: requiredDepsMet,
    database,
    service: 'book-ferry',
    dependencies: {
      database,
      redis,
    },
    search: {
      engine: 'postgres-keyword',
      queryExpansion: true,
      trigramOptional: true,
    },
    timestamp: new Date().toISOString(),
  });
}
