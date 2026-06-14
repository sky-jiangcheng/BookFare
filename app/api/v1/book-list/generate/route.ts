import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import type { ParsedRequirements } from '@/lib/book-list/types';
import { BookListHttpError, generateBookList } from '@/lib/book-list/service';
import { validateConfig } from '@/lib/config/environment';
import { buildSafeErrorResponse, logServerError } from '@/lib/utils/safe-error';

// Vercel 超时上限：60 秒（服务端 timeout 配置不应超过此值）
export const maxDuration = 60;

const categorySchema = z.object({
  category: z.string(),
  percentage: z.number().optional(),
  count: z.number().optional(),
});

const parsedRequirementsSchema = z.object({
  target_audience: z.string().nullable().optional(),
  cognitive_level: z.string().nullable().optional(),
  categories: z.array(categorySchema).optional(),
  keywords: z.array(z.string()).optional(),
  constraints: z.array(z.string()).optional(),
  exclude_textbooks: z.boolean().optional(),
  min_cognitive_level: z.string().nullable().optional(),
});

const generateSchema = z
  .object({
    request_id: z
      .string()
      .max(128)
      .optional()
      .nullable()
      .transform((s) => (s && s.trim() ? s.trim() : undefined)),
    requirements: parsedRequirementsSchema.nullable().optional(),
    // This endpoint runs with a 60s maxDuration (see vercel.json) and the
    // catalog repository caps search at 10,000 rows, so the limit can scale
    // up to that ceiling. The chat endpoint (9s timeout) keeps a lower bound.
    limit: z.number().int().min(5).max(10000).optional(),
    save_to_history: z.boolean().optional(),
    auto_complete: z.boolean().optional(),
  })
  .refine((d) => Boolean(d.request_id) || d.requirements != null, {
    message: '必须提供 request_id 或 requirements',
  });

export async function POST(req: NextRequest) {
  try {
    validateConfig();
    const json = await req.json();
    const body = generateSchema.parse(json);
    const data = await generateBookList({
      request_id: body.request_id ?? undefined,
      requirements: body.requirements as ParsedRequirements | undefined,
      limit: body.limit,
      save_to_history: body.save_to_history,
      auto_complete: body.auto_complete,
    });
    return NextResponse.json(data);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }
    if (err instanceof BookListHttpError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    logServerError('[book-list/generate]', err);
    return NextResponse.json(
      buildSafeErrorResponse(err, '生成书单失败'),
      { status: 500 },
    );
  }
}
