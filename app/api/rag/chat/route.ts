import { NextRequest, NextResponse } from 'next/server';
import { runRAGPipeline } from '@/lib/agents/orchestrator';
import type { RAGPipelineResult } from '@/lib/agents/orchestrator';
import { validateConfig, config } from '@/lib/config/environment';
import type { AgentProgress, RequirementAnalysis } from '@/lib/types/rag';
import { corsHeaders, handleCorsPreflightRequest } from '@/lib/utils/cors';
import { getSafeErrorMessage, buildSafeErrorResponse, logServerError } from '@/lib/utils/safe-error';
import { buildRecommendationSummary } from '@/lib/utils/recommendation-summary';
import { z } from 'zod';

const requirementSchema = z.object({
  original_query: z.string(),
  categories: z.array(z.string()),
  keywords: z.array(z.string()),
  expanded_search_terms: z.array(z.string()),
  constraints: z.object({
    budget: z.number().optional(),
    target_count: z.number().optional(),
    author: z.string().optional(),
    price_min: z.number().optional(),
    price_max: z.number().optional(),
    publication_year_min: z.number().int().min(1900).max(2100).optional(),
    exclude_keywords: z.array(z.string()).optional(),
  }),
  preferences: z.array(z.string()),
  needs_clarification: z.boolean(),
  clarification_questions: z.array(z.string()),
  analysis_strategy: z.enum(['llm', 'local-fallback']).optional(),
});

const STREAM_TIMEOUT_MS = 9000;

function encodeSseEvent(event: string, data: unknown): Uint8Array {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  return new TextEncoder().encode(payload);
}

/**
 * 请求体验证 schema。
 * 防止超长输入、空查询、非字符串类型等安全问题。
 */
const chatRequestSchema = z.object({
  query: z.string()
    .min(1, 'Query cannot be empty')
    .max(2000, 'Query too long (max 2000 characters)')
    .transform((q) => q.trim()),
  sessionId: z.string()
    .max(128, 'Session ID too long')
    .optional()
    .transform((s) => s?.trim() || undefined),
  fast: z.boolean().optional().default(false),
  // Recommendation count ceiling for the chat endpoint. The chat path runs
  // under a ~9s timeout, so this stays well below the DB/export ceiling
  // (10,000) reachable via the book-list generation API. The TuningPanel UI
  // matches this bound so the slider can never request more than allowed here.
  limit: z.number().int().min(1).max(200).optional(),
  excludeKeywords: z.array(z.string()).optional(),
  categoryWeight: z.number().min(0).max(10).optional(),
  keywordWeight: z.number().min(0).max(10).optional(),
  confirmedRequirement: requirementSchema.optional(),
  libraryCategory: z.string().optional(),
});

export async function OPTIONS(req: NextRequest) {
  return handleCorsPreflightRequest(req);
}

export async function POST(req: NextRequest) {
  try {
    // Validate configuration
    validateConfig();

    // Validate Content-Type
    const contentType = req.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      return NextResponse.json(
        { error: 'Content-Type must be application/json' },
        { status: 415, headers: corsHeaders(req) }
      );
    }

    // Parse and validate request body with Zod
    const rawBody = await req.json();
    const parseResult = chatRequestSchema.safeParse(rawBody);

    if (!parseResult.success) {
      return NextResponse.json(
        { error: 'Invalid request', details: parseResult.error.flatten() },
        { status: 400, headers: corsHeaders(req) }
      );
    }

    const { query, sessionId, fast, limit, excludeKeywords, categoryWeight, keywordWeight, confirmedRequirement, libraryCategory } = parseResult.data;

    return await handleRequest(query, sessionId, fast, limit, excludeKeywords, categoryWeight, keywordWeight, confirmedRequirement, libraryCategory, req);
  } catch (error) {
    logServerError('[RAG Chat]', error);
    return NextResponse.json(
      buildSafeErrorResponse(error, '处理请求时发生错误'),
      { status: 500, headers: corsHeaders(req) }
    );
  }
}

async function handleRequest(
  query: string,
  sessionId: string | undefined,
  fast: boolean,
  limit: number | undefined,
  excludeKeywords: string[] | undefined,
  categoryWeight: number | undefined,
  keywordWeight: number | undefined,
  confirmedRequirement: RequirementAnalysis | undefined,
  libraryCategory: string | undefined,
  req: NextRequest
) {
  try {
    const pipelineOpts = {
      userQuery: query,
      sessionId,
      enableConversationMemory: true,
      limit,
      excludeKeywords,
      categoryWeight,
      keywordWeight,
      requirement: confirmedRequirement,
      libraryCategory,
    };

    if (fast) {
      const result = await runRAGPipeline(pipelineOpts);
      return NextResponse.json(
        { ...result, summary: buildRecommendationSummary(result) },
        { headers: corsHeaders(req) }
      );
    }

    if (!config.vercel.enabled) {
      return await handleFullPipeline(query, sessionId, limit, excludeKeywords, categoryWeight, keywordWeight, confirmedRequirement, libraryCategory, req);
    }

    const result = await runRAGPipeline(pipelineOpts);
    return NextResponse.json(
      { ...result, summary: buildRecommendationSummary(result) },
      { headers: corsHeaders(req) }
    );
  } catch (error) {
    logServerError('[RAG Chat]', error);
    return NextResponse.json(
      buildSafeErrorResponse(error, '处理请求时发生错误'),
      { status: 500, headers: corsHeaders(req) }
    );
  }
}

async function handleFullPipeline(
  query: string,
  sessionId: string | undefined,
  limit: number | undefined,
  excludeKeywords: string[] | undefined,
  categoryWeight: number | undefined,
  keywordWeight: number | undefined,
  confirmedRequirement: RequirementAnalysis | undefined,
  libraryCategory: string | undefined,
  req: NextRequest
) {
  try {
    // Set up SSE streaming
    const stream = new ReadableStream({
      start(controller) {
        let aborted = false;
        let isClosed = false;

        const closeStream = () => {
          if (isClosed) return;
          isClosed = true;
          try { controller.close(); } catch { /* ignore */ }
        };

        const onAbort = () => {
          aborted = true;
          closeStream();
        };
        req.signal.addEventListener('abort', onAbort);

        const onProgress: (progress: AgentProgress) => void = (progress) => {
          if (aborted) return;
          controller.enqueue(encodeSseEvent('progress', progress));
        };

        const pipelinePromise = runRAGPipeline({
          userQuery: query,
          sessionId,
          enableConversationMemory: true,
          onProgress,
          limit,
          excludeKeywords,
          categoryWeight,
          keywordWeight,
          requirement: confirmedRequirement,
          libraryCategory,
        });

        pipelinePromise.then((result: RAGPipelineResult) => {
          req.signal.removeEventListener('abort', onAbort);
          if (result.success) {
            controller.enqueue(encodeSseEvent('complete', {
              ...result,
              summary: buildRecommendationSummary(result),
            }));
          } else {
            controller.enqueue(encodeSseEvent('error', {
              ...result,
              error: getSafeErrorMessage(result.error),
            }));
          }
          closeStream();
        }).catch((error: Error) => {
          req.signal.removeEventListener('abort', onAbort);
          controller.enqueue(encodeSseEvent('error', {
            success: false,
            error: getSafeErrorMessage(error),
            iterations: 0,
          }));
          closeStream();
        });

        setTimeout(() => {
          if (isClosed) return;
          controller.enqueue(encodeSseEvent('error', {
            success: false,
            error: 'Request timeout',
            iterations: 0,
          }));
          closeStream();
        }, STREAM_TIMEOUT_MS);
      },
    });

    // Return SSE response
    return new NextResponse(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        ...corsHeaders(req),
      },
    });
  } catch (error) {
    logServerError('[RAG Chat SSE]', error);
    return NextResponse.json(
      buildSafeErrorResponse(error, '处理请求时发生错误'),
      { status: 500, headers: corsHeaders(req) }
    );
  }
}
