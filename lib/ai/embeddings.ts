import 'server-only';

import config from '@/lib/config/environment';
import { assertEmbeddingDimension } from '@/lib/embedding-dimension.mjs';

/**
 * ADR-0002: Gemini embeddings client for semantic recall.
 *
 * Uses the Gemini native REST API (`batchEmbedContents` / `embedContent`) so we
 * can set per-request `taskType` — `RETRIEVAL_DOCUMENT` for the offline book
 * backfill and `RETRIEVAL_QUERY` for query-time embedding — which materially
 * improves retrieval quality versus the OpenAI-compatible endpoint.
 */

export const RETRIEVAL_DOCUMENT = 'RETRIEVAL_DOCUMENT' as const;
export const RETRIEVAL_QUERY = 'RETRIEVAL_QUERY' as const;
export type EmbeddingTaskType = typeof RETRIEVAL_DOCUMENT | typeof RETRIEVAL_QUERY;

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/** Gemini batchEmbedContents accepts up to 100 requests per call; stay conservative. */
export const MAX_EMBEDDING_BATCH_SIZE = 100;
export const DEFAULT_EMBEDDING_BATCH_SIZE = 32;
/** Truncate long descriptions to keep embedding inputs bounded. */
export const MAX_EMBEDDING_TEXT_LENGTH = 2000;

export interface EmbeddingOptions {
  apiKey?: string;
  model?: string;
  dimensions?: number;
  taskType?: EmbeddingTaskType;
  fetchImpl?: typeof fetch;
}

interface EmbedContentRequest {
  model: string;
  content: { parts: Array<{ text: string }> };
  taskType?: EmbeddingTaskType;
  outputDimensionality?: number;
}

interface BatchEmbedContentResponse {
  embeddings?: Array<{ values?: number[] }>;
}

interface SingleEmbedContentResponse {
  embedding?: { values?: number[] };
}

export function chunkArray<T>(items: T[], size: number): T[][] {
  const safeSize = Math.max(1, Math.floor(size));
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += safeSize) {
    chunks.push(items.slice(i, i + safeSize));
  }
  return chunks;
}

export function truncateEmbeddingText(text: string, maxLength: number = MAX_EMBEDDING_TEXT_LENGTH): string {
  return text.length <= maxLength ? text : text.slice(0, maxLength);
}

export function buildBatchEmbeddingRequest(
  texts: string[],
  options: Pick<EmbeddingOptions, 'model' | 'dimensions' | 'taskType'> = {},
): { requests: EmbedContentRequest[] } {
  const model = options.model ?? config.embedding.model;
  const dimensions = options.dimensions ?? config.embedding.dimensions;
  const taskType = options.taskType ?? RETRIEVAL_DOCUMENT;

  return {
    requests: texts.map((text) => ({
      model: `models/${model}`,
      content: { parts: [{ text }] },
      taskType,
      outputDimensionality: dimensions,
    })),
  };
}

export function parseBatchEmbeddingResponse(payload: unknown): number[][] {
  const embeddings = (payload as BatchEmbedContentResponse | null)?.embeddings;
  if (!Array.isArray(embeddings)) {
    throw new Error('Embedding response is missing `embeddings` array');
  }
  return embeddings.map((entry, index) => {
    const values = entry?.values;
    if (!Array.isArray(values) || values.length === 0) {
      throw new Error(`Embedding response entry ${index} has no values`);
    }
    return values;
  });
}

export function parseSingleEmbeddingResponse(payload: unknown): number[] {
  const values = (payload as SingleEmbedContentResponse | null)?.embedding?.values;
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('Embedding response is missing `embedding.values`');
  }
  return values;
}

/** Render an embedding as a pgvector text literal (cast with `::vector` in SQL). */
export function vectorToPgLiteral(values: number[]): string {
  return `[${values.join(',')}]`;
}

async function postJson(
  url: string,
  apiKey: string,
  body: unknown,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Gemini embedding API failed (${response.status}): ${detail.slice(0, 300)}`);
  }

  return response.json();
}

/**
 * Embed a batch of texts. Batches internally; order of the returned vectors
 * matches the order of the input texts.
 */
export async function embedTexts(
  texts: string[],
  options: EmbeddingOptions = {},
): Promise<number[][]> {
  const apiKey = options.apiKey ?? config.google.apiKey;
  if (!apiKey) {
    throw new Error('Missing GOOGLE_API_KEY for embedding generation');
  }

  const model = options.model ?? config.embedding.model;
  const dimensions = options.dimensions ?? config.embedding.dimensions;
  const taskType = options.taskType ?? RETRIEVAL_DOCUMENT;
  const fetchImpl = options.fetchImpl ?? fetch;

  const vectors: number[][] = [];
  for (const chunk of chunkArray(texts, DEFAULT_EMBEDDING_BATCH_SIZE)) {
    const url = `${GEMINI_API_BASE}/models/${model}:batchEmbedContents`;
    const payload = await postJson(url, apiKey, buildBatchEmbeddingRequest(chunk, { model, dimensions, taskType }), fetchImpl);
    const chunkVectors = parseBatchEmbeddingResponse(payload);
    if (chunkVectors.length !== chunk.length) {
      throw new Error(`Embedding count mismatch: sent ${chunk.length}, got ${chunkVectors.length}`);
    }
    // Gemini may ignore `outputDimensionality` for some models — verify before
    // the vectors reach Postgres, where the mismatch surfaces as an opaque
    // pgvector error inside a query.
    for (const vector of chunkVectors) {
      assertEmbeddingDimension(vector, dimensions);
    }
    vectors.push(...chunkVectors);
  }
  return vectors;
}

/** Embed a single query text with the RETRIEVAL_QUERY task type. */
export async function embedQueryText(text: string, options: EmbeddingOptions = {}): Promise<number[]> {
  const apiKey = options.apiKey ?? config.google.apiKey;
  if (!apiKey) {
    throw new Error('Missing GOOGLE_API_KEY for embedding generation');
  }

  const model = options.model ?? config.embedding.model;
  const dimensions = options.dimensions ?? config.embedding.dimensions;
  const fetchImpl = options.fetchImpl ?? fetch;

  const body: EmbedContentRequest = {
    model: `models/${model}`,
    content: { parts: [{ text }] },
    taskType: options.taskType ?? RETRIEVAL_QUERY,
    outputDimensionality: dimensions,
  };

  const payload = await postJson(
    `${GEMINI_API_BASE}/models/${model}:embedContent`,
    apiKey,
    body,
    fetchImpl,
  );
  const values = parseSingleEmbeddingResponse(payload);
  assertEmbeddingDimension(values, dimensions);
  return values;
}
