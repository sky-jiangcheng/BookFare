// lib/upstash.ts
import { Redis } from '@upstash/redis';
import { hasRedisConfig } from '@/lib/config/environment';

/** Lazy singleton: Upstash Redis client, null when unconfigured or URL invalid */
export const redis: Redis | null = (() => {
  if (!hasRedisConfig()) return null;
  try {
    return new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL || '',
      token: process.env.UPSTASH_REDIS_REST_TOKEN || '',
    });
  } catch (error) {
    // Redis misconfiguration silently disables rate-limiting, session memory,
    // and feedback — surface the failure so it doesn't go unnoticed.
    console.error('[upstash] Failed to initialize Redis client (rate-limit/memory/feedback will be degraded):', error);
    return null;
  }
})();
