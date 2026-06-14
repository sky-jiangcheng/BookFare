export interface MessageType {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  recommendations?: BookRecommendation[];
  requirement?: RequirementSnapshot;
  totalPrice?: number;
  sessionId?: string;
  status?: 'streaming' | 'done' | 'error';
}

export interface BookRecommendation {
  title: string;
  author: string;
  price: number;
  explanation: string;
  book_id: string;
  publisher?: string | null;
  publication_year?: number | null;
  category?: string | null;
  stock?: number | null;
  match_score?: number;
  source?: string | null;
  remark?: string | null;
}

export interface RequirementSnapshot {
  categories: string[];
  keywords: string[];
  constraints: {
    budget?: number;
    target_count?: number;
    publication_year_min?: number;
    exclude_keywords?: string[];
  };
}

export interface AssistantMessageType {
  recommendations?: BookRecommendation[];
  requirement?: RequirementSnapshot;
  totalPrice?: number;
}

/**
 * Build a human-readable booklist file/sheet name from the user's query and
 * parsed requirement (e.g. "历史_15本"). Falls back to a cleaned slice of the
 * raw input, or "书单" when nothing useful is available.
 */
export function generateBooklistName(
  userInput: string,
  requirement?: { categories?: string[]; constraints?: { target_count?: number } },
): string {
  const cleanInput = userInput
    .trim()
    .replace(/[^\w\u4e00-\u9fa5\s]/g, '')
    .replace(/_+/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 20);

  if (!requirement || !requirement.categories || requirement.categories.length === 0) {
    return cleanInput || '书单';
  }

  const primaryCategory = requirement.categories[0].replace(/_+/g, '');
  const targetCount = requirement.constraints?.target_count;
  return targetCount ? `${primaryCategory}_${targetCount}本` : (primaryCategory || cleanInput || '书单');
}

/**
 * Persisted chat session shape (mirrors the localStorage "rag-chat-sessions" entry).
 * Shared between rag-chat.tsx and SidebarContent so neither has to re-declare it.
 */
export interface SessionItem {
  id: string;
  remoteSessionId?: string;
  title: string;
  messages: MessageType[];
  lastSql?: string;
  targetCount: number;
  categoryWeight: number;
  keywordWeight: number;
  selectedExclusions: string[];
  selectedKeywords?: string[];
  libraryCategory?: string;
}

export function attachRemoteSessionId<T extends { id: string }>(
  session: T,
  remoteSessionId: string,
): T & { remoteSessionId: string } {
  return {
    ...session,
    remoteSessionId,
  };
}

export function recoverInterruptedMessages(messages: MessageType[]): MessageType[] {
  return messages.map((message) => {
    if (message.status !== 'streaming') return message;

    return {
      ...message,
      content: '上次查询因页面刷新或标签页关闭而中断，请重新查询。',
      status: 'error',
    };
  });
}

export function buildFollowUpPrompts(lastUserQuery: string, assistantMessage?: AssistantMessageType) {
  if (!lastUserQuery) {
    return [];
  }

  const truncatedQuery = lastUserQuery.length > 50 ? lastUserQuery.slice(0, 47) + '...' : lastUserQuery;

  const recommendations = assistantMessage?.recommendations ?? [];
  const requirement = assistantMessage?.requirement;
  const budget = requirement?.constraints.budget;
  const targetCount = requirement?.constraints.target_count;
  const excluded = requirement?.constraints.exclude_keywords ?? [];
  const totalPrice = assistantMessage?.totalPrice ?? 0;

  if (recommendations.length === 0) {
    return [
      `沿用"${truncatedQuery}"，补充"给谁读 + 推荐几本 + 预算上限"`,
      `沿用"${truncatedQuery}"，加一条"排除教材/教辅"`,
      `沿用"${truncatedQuery}"，指定更明确主题词（例如历史/AI/管理）`,
    ];
  }

  const prompts: string[] = [];
  const firstTitle = recommendations[0]?.title;

  if (firstTitle) {
    prompts.push(`保持当前主题，围绕《${firstTitle}》再补充 3 本同主题书`);
  }

  if (typeof budget === 'number') {
    prompts.push(`基于"${truncatedQuery}"，保持预算 ¥${budget} 不变，替换成更高相关度的书`);
    if (totalPrice > budget) {
      prompts.push(`基于"${truncatedQuery}"，严格把总价压到 ¥${budget} 以内`);
    }
  } else {
    prompts.push(`基于"${truncatedQuery}"，增加硬预算约束：总价不超过 150 元`);
  }

  if (typeof targetCount === 'number') {
    prompts.push(`基于"${truncatedQuery}"，数量固定 ${targetCount} 本，优先保留最相关的`);
  } else {
    prompts.push(`基于"${truncatedQuery}"，把数量固定为 5 本并给出排序理由`);
  }

  if (excluded.length === 0) {
    prompts.push(`基于"${truncatedQuery}"，增加排除词：教材、教辅`);
  } else {
    prompts.push(`基于"${truncatedQuery}"，继续排除：${excluded.join('、')}，并补充同主题替代书`);
  }

  return Array.from(new Set(prompts)).slice(0, 3);
}

export function normalizeBookRecommendations(
  raw: Array<Record<string, unknown>>,
  options: { normalizeScore?: boolean } = {},
): BookRecommendation[] {
  const { normalizeScore = false } = options;

  // When requested, derive match_score from relevance_score normalized to the max.
  // This mirrors the legacy inline reduce(...) + map(...) logic the chat UI relied on.
  const maxRelevance = normalizeScore
    ? raw.reduce((max, item) => {
        const score = typeof item.relevance_score === 'number' ? item.relevance_score : 0;
        return score > max ? score : max;
      }, 0)
    : 0;

  return raw
    .map((item) => {
      let matchScore: number | undefined =
        typeof item.match_score === 'number' ? item.match_score : undefined;

      if (
        matchScore === undefined &&
        normalizeScore &&
        typeof item.relevance_score === 'number'
      ) {
        matchScore = maxRelevance > 0 ? item.relevance_score / maxRelevance : 0.9;
      }

      return {
        title: typeof item.title === 'string' ? item.title.trim() || '未命名图书' : '未命名图书',
        author: typeof item.author === 'string' ? item.author.trim() : '未知作者',
        price: typeof item.price === 'number' ? item.price : Number(item.price) || 0,
        explanation: typeof item.explanation === 'string' ? item.explanation.trim() : '',
        book_id: item.book_id == null ? '' : String(item.book_id),
        publisher: typeof item.publisher === 'string' ? item.publisher.trim() || null : null,
        publication_year: typeof item.publication_year === 'number'
          ? item.publication_year
          : (Number(item.publication_year) || null),
        category: typeof item.category === 'string' ? item.category.trim() || null : null,
        stock: typeof item.stock === 'number' ? item.stock : null,
        match_score: matchScore,
        source: typeof item.source === 'string' ? item.source.trim() || null : null,
        remark: typeof item.remark === 'string' ? item.remark.trim() || null : null,
      };
    })
    // Drop a record only when BOTH title and author are missing — keep entries
    // that still carry an identifying signal on either side. (Previously `&&`
    // dropped any record whose title was empty even when the author was valid.)
    .filter((r) => r.title !== '未命名图书' || r.author !== '未知作者');
}

/**
 * Parse and dispatch a Server-Sent Events stream produced by /api/rag/chat.
 *
 * The stream uses the standard `event:` / `data:` framing. Recognized events:
 *  - `progress`: incremental status update (optionally carrying a `data.sql` preview)
 *  - `complete`: terminal success payload with the final recommendation
 *  - `error`: terminal failure payload with an error message
 *
 * Returns true if a terminal event (complete/error) was seen, false otherwise
 * (e.g. the stream ended unexpectedly), so the caller can decide how to react.
 */
export async function consumeSSEStream(
  response: Response,
  handlers: {
    onProgress?: (data: Record<string, unknown>) => void;
    onComplete?: (data: Record<string, unknown>) => void;
    onError?: (data: Record<string, unknown>) => void;
  },
): Promise<boolean> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('无法读取服务响应');

  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = 'message';
  let sawTerminalEvent = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.startsWith('event:')) {
        currentEvent = line.slice(6).trim();
        continue;
      }
      if (!line.startsWith('data:')) continue;

      const dataStr = line.slice(5).trim();
      if (!dataStr || dataStr === '[DONE]') continue;

      let data: Record<string, unknown>;
      try {
        data = JSON.parse(dataStr);
      } catch (parseError) {
        console.error('Failed to parse SSE data:', parseError);
        continue;
      }

      if (currentEvent === 'progress') {
        handlers.onProgress?.(data);
      } else if (currentEvent === 'complete') {
        sawTerminalEvent = true;
        handlers.onComplete?.(data);
      } else if (currentEvent === 'error') {
        sawTerminalEvent = true;
        handlers.onError?.(data);
      }
    }
  }

  return sawTerminalEvent;
}

/**
 * Row shape produced for the Excel export endpoint.
 */
export interface ExportBook {
  book_id?: number;
  title: string;
  author?: string | null;
  publisher?: string | null;
  publication_year?: number | null;
  category?: string | null;
  price?: number | null;
  stock?: number | null;
  score?: number | null;
  source?: string;
  remark?: string | null;
}

/**
 * Aggregate book recommendations across all assistant messages into a deduplicated
 * list suitable for the Excel export endpoint. Books are deduped by `book_id`.
 */
export function collectExportBooks(messages: MessageType[]): ExportBook[] {
  const seenBookIds = new Set<string>();
  const allBooks: ExportBook[] = [];

  messages.forEach((msg) => {
    if (msg.role !== 'assistant' || !msg.recommendations) return;
    msg.recommendations.forEach((book) => {
      const bookId = String(book.book_id);
      if (!bookId || seenBookIds.has(bookId)) return;
      seenBookIds.add(bookId);

      const numericBookId = Number(bookId);
      allBooks.push({
        book_id: Number.isSafeInteger(numericBookId) ? numericBookId : undefined,
        title: book.title?.trim() || '未知书名',
        author: book.author || null,
        publisher: book.publisher || null,
        publication_year: book.publication_year ?? null,
        category: book.category || null,
        price: typeof book.price === 'number' ? book.price : null,
        stock: typeof book.stock === 'number' ? book.stock : null,
        score: typeof book.match_score === 'number' ? Math.round(book.match_score * 100) : null,
        source: book.source || '智能推荐',
        remark: book.explanation || book.remark || null,
      });
    });
  });

  return allBooks;
}

export function normalizeRequirementSnapshot(
  raw: Record<string, unknown>,
): RequirementSnapshot {
  const constraints = (raw.constraints ?? {}) as Record<string, unknown>;
  return {
    categories: Array.isArray(raw.categories) ? raw.categories as string[] : [],
    keywords: Array.isArray(raw.keywords) ? raw.keywords as string[] : [],
    constraints: {
      budget: typeof constraints.budget === 'number' ? constraints.budget : (constraints.budget != null ? Number(constraints.budget) : undefined),
      target_count: constraints.target_count != null ? Number(constraints.target_count) : undefined,
      ...(constraints.publication_year_min != null
        ? {
            publication_year_min: typeof constraints.publication_year_min === 'number'
              ? constraints.publication_year_min
              : Number(constraints.publication_year_min) || undefined,
          }
        : {}),
      exclude_keywords: Array.isArray(constraints.exclude_keywords) ? constraints.exclude_keywords as string[] : [],
    },
  };
}
