import 'server-only';

export const config = {
  google: {
    apiKey: process.env.GOOGLE_API_KEY || '',
    model: process.env.GOOGLE_MODEL || 'gemini-2.0-flash',
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    baseUrl: process.env.OPENAI_BASE_URL || '',
    model: process.env.OPENAI_MODEL || '',
  },
  database: {
    url: process.env.POSTGRES_URL || process.env.DATABASE_URL || '',
  },
  upstash: {
    redisUrl: process.env.UPSTASH_REDIS_REST_URL || '',
    redisToken: process.env.UPSTASH_REDIS_REST_TOKEN || '',
  },
  services: {
    authUrl: process.env.AUTH_SERVICE_URL || '',
  },
  app: {
    url: process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
  },
  rag: {
    defaultTargetCount: 15,
  },
  search: {
    // ADR-0002: semantic recall via pgvector; disable to fall back to keyword-only recall.
    semanticRecall: process.env.ENABLE_SEMANTIC_RECALL !== 'false',
    semanticTopK: Number(process.env.SEMANTIC_TOP_K) || 100,
    // ADR-0003: PG native tsvector full-text ranking signal.
    fulltextRank: process.env.ENABLE_FULLTEXT_RANK !== 'false',
    // ADR-0004: deterministic domain-graph neighbor expansion (book_edges + recursive CTE).
    graphNeighbors: process.env.ENABLE_GRAPH_NEIGHBORS !== 'false',
    graphSeedCount: Number(process.env.GRAPH_SEED_COUNT) || 10,
    graphDepth: Number(process.env.GRAPH_DEPTH) || 2,
    graphNeighborLimit: Number(process.env.GRAPH_NEIGHBOR_LIMIT) || 100,
  },
  embedding: {
    model: process.env.EMBEDDING_MODEL || 'gemini-embedding-001',
    dimensions: Number(process.env.EMBEDDING_DIMENSIONS) || 768,
  },
  // Vercel Deployment
  vercel: {
    enabled: process.env.VERCEL === 'true' || process.env.VERCEL_ENV !== undefined,
    timeout: Number(process.env.VERCEL_TIMEOUT) || 7000, // 7 seconds (under 10s limit with cold start headroom)
  },
  feedback: {
    enabled: process.env.ENABLE_FEEDBACK !== 'false',
    storage: process.env.FEEDBACK_STORAGE || 'redis',
  },
  conversation: {
    enabled: process.env.ENABLE_CONVERSATION_MEMORY !== 'false',
    ttl: Number(process.env.CONVERSATION_TTL) || 3600,
    maxTurns: Number(process.env.MAX_CONVERSATION_TURNS) || 20,
  },
} as const;

export function validateConfig(): void {
  const missing: string[] = [];
  if (!config.google.apiKey) missing.push('GOOGLE_API_KEY');
  if (!config.database.url) missing.push('POSTGRES_URL or DATABASE_URL');

  if (missing.length > 0) {
    console.warn(`[config] Missing environment variables: ${missing.join(', ')}. Some features may not work.`);
  }
}

export function hasDatabaseConfig(): boolean {
  return Boolean(config.database.url);
}

export function hasRedisConfig(): boolean {
  return Boolean(config.upstash.redisUrl && config.upstash.redisToken);
}

/**
 * ADR-0002 semantic recall: requires the feature flag, a Gemini API key
 * (to embed the query) and a database. Degrades silently to keyword-only
 * recall when any precondition is missing.
 */
export function isSemanticRecallEnabled(): boolean {
  return config.search.semanticRecall && Boolean(config.google.apiKey) && hasDatabaseConfig();
}

/** ADR-0003 full-text ranking signal (ts_rank_cd over the search_tsv column). */
export function isFulltextRankEnabled(): boolean {
  return config.search.fulltextRank && hasDatabaseConfig();
}

/** ADR-0004 graph neighbor expansion (book_edges + recursive CTE). */
export function isGraphNeighborsEnabled(): boolean {
  return config.search.graphNeighbors && hasDatabaseConfig();
}

export default config;
