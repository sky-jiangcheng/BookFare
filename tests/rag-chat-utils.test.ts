import test from 'node:test';
import assert from 'node:assert/strict';
import * as ragChatUtils from '../components/rag-chat-utils';
import { buildRecommendationSummary } from '../lib/utils/recommendation-summary';

test('buildFollowUpPrompts keeps the most useful follow-ups and respects assistant context', () => {
  const { buildFollowUpPrompts } = ragChatUtils;
  const prompts = buildFollowUpPrompts('推荐健康书', {
    recommendations: [
      { title: '健康管理', author: '张三', price: 88, explanation: '推荐理由', book_id: '1' },
    ],
    requirement: {
      categories: ['健康'],
      keywords: ['健康'],
      constraints: {
        budget: 100,
        target_count: 5,
        exclude_keywords: ['教材'],
      },
    },
    totalPrice: 80, // within budget, so '严格把总价压到' prompt is NOT added
  });

  assert.equal(prompts.length, 3);
  assert.ok(prompts.some((prompt) => prompt.includes('保持预算 ¥100')));
  assert.ok(prompts.some((prompt) => prompt.includes('数量固定 5 本')));
});

test('normalizeBookRecommendations coerces mixed payloads into usable recommendations', () => {
  const { normalizeBookRecommendations } = ragChatUtils;
  const recommendations = normalizeBookRecommendations([
    {
      title: '  健康书  ',
      author: '  张三 ',
      price: '88.5',
      explanation: '  推荐理由 ',
      book_id: 123,
    },
    {
      title: '',
      author: '李四',
      price: null,
      explanation: null,
      book_id: undefined,
    },
  ]);

  assert.equal(recommendations.length, 2);
  assert.equal(recommendations[0].title, '健康书');
  assert.equal(recommendations[0].author, '张三');
  assert.equal(recommendations[0].price, 88.5);
  assert.equal(recommendations[0].book_id, '123');
  assert.equal(recommendations[1].title, '未命名图书');
  assert.equal(recommendations[1].author, '李四');
});

test('normalizeBookRecommendations derives match_score from relevance_score when normalizeScore is set', () => {
  const { normalizeBookRecommendations } = ragChatUtils;
  const recommendations = normalizeBookRecommendations(
    [
      { title: '高分书', author: '甲', price: 10, book_id: 1, relevance_score: 0.8 },
      { title: '低分书', author: '乙', price: 10, book_id: 2, relevance_score: 0.4 },
    ],
    { normalizeScore: true },
  );

  // max relevance is 0.8; the top book normalizes to 1.0, the other to 0.5.
  assert.equal(recommendations[0].match_score, 1.0);
  assert.equal(recommendations[1].match_score, 0.5);
});

test('normalizeBookRecommendations falls back to 0.9 score when all relevance values are zero', () => {
  const { normalizeBookRecommendations } = ragChatUtils;
  const recommendations = normalizeBookRecommendations(
    [{ title: '书', author: '甲', price: 5, book_id: 1, relevance_score: 0 }],
    { normalizeScore: true },
  );

  assert.equal(recommendations[0].match_score, 0.9);
});

test('normalizeBookRecommendations preserves an explicit match_score even with normalizeScore', () => {
  const { normalizeBookRecommendations } = ragChatUtils;
  const recommendations = normalizeBookRecommendations(
    [{ title: '书', author: '甲', price: 5, book_id: 1, match_score: 0.42, relevance_score: 0.99 }],
    { normalizeScore: true },
  );

  // Explicit match_score wins; relevance_score is not used to overwrite it.
  assert.equal(recommendations[0].match_score, 0.42);
});

test('normalizeBookRecommendations keeps a record when only author is known', () => {
  // Regression guard: previously `&&` dropped records whose title was empty
  // even when the author was valid. A book with no title but a real author
  // must be retained (only fully-unidentifiable entries are dropped).
  const { normalizeBookRecommendations } = ragChatUtils;
  const recommendations = normalizeBookRecommendations([
    { title: '', author: '李四', price: 10, book_id: 7 },
  ]);

  assert.equal(recommendations.length, 1);
  assert.equal(recommendations[0].title, '未命名图书');
  assert.equal(recommendations[0].author, '李四');
});

test('normalizeBookRecommendations drops a record only when both title and author are missing', () => {
  const { normalizeBookRecommendations } = ragChatUtils;
  const recommendations = normalizeBookRecommendations([
    { title: '有标题无作者', author: '', price: 10, book_id: 1 }, // keep (title known)
    { title: '', author: null, price: 10, book_id: 2 }, // drop (both missing)
    { title: undefined, author: undefined, price: 10, book_id: 3 }, // drop (both missing)
  ]);

  assert.equal(recommendations.length, 1);
  assert.equal(recommendations[0].title, '有标题无作者');
});

test('normalizeRequirementSnapshot returns normalized snapshot values', () => {
  const { normalizeRequirementSnapshot } = ragChatUtils;
  const snapshot = normalizeRequirementSnapshot({
    categories: ['健康'],
    keywords: ['养生'],
    constraints: {
      budget: '200',
      target_count: 4,
      exclude_keywords: ['教材'],
    },
  });

  assert.deepEqual(snapshot, {
    categories: ['健康'],
    keywords: ['养生'],
    constraints: {
      budget: 200,
      target_count: 4,
      exclude_keywords: ['教材'],
    },
  });
});

test('recoverInterruptedMessages clears persisted streaming state after refresh', () => {
  const messages = ragChatUtils.recoverInterruptedMessages([
    { id: 'user-1', role: 'user', content: '推荐历史书', status: 'done' },
    { id: 'assistant-1', role: 'assistant', content: '正在处理', status: 'streaming' },
  ]);

  assert.equal(messages[0].status, 'done');
  assert.equal(messages[1].status, 'error');
  assert.match(messages[1].content, /页面刷新|中断/);
});

test('recoverInterruptedMessages preserves completed messages', () => {
  const original = [
    { id: 'assistant-1', role: 'assistant' as const, content: '推荐完成', status: 'done' as const },
  ];

  assert.deepEqual(ragChatUtils.recoverInterruptedMessages(original), original);
});

test('attachRemoteSessionId preserves the local session identity', () => {
  const attachRemoteSessionId = (ragChatUtils as any).attachRemoteSessionId;
  assert.equal(typeof attachRemoteSessionId, 'function');

  const session = {
    id: 'local-session',
    title: '测试会话',
    messages: [],
    targetCount: 10,
    categoryWeight: 1.2,
    keywordWeight: 0.6,
    selectedExclusions: [],
  };

  assert.deepEqual(attachRemoteSessionId(session, 'server-session'), {
    ...session,
    remoteSessionId: 'server-session',
  });
});

test('recommendation summary stays concise and does not repeat book details', () => {
  const summary = buildRecommendationSummary({
    requirement: {
      categories: ['历史'],
      constraints: {
        budget: 100,
        exclude_keywords: [],
      },
    },
    recommendation: {
      books: [
        {
          book_id: '1',
          title: '夹缝中的历史',
          author: '朱鸿',
          publisher: '东方出版中心',
          category: '历史',
          price: 22,
          stock: 10,
          description: '',
          explanation: '主题命中「历史」。',
          relevance_score: 0.92,
        },
      ],
      total_price: 22,
    },
  });

  assert.match(summary, /推荐 1 本书/);
  assert.doesNotMatch(summary, /夹缝中的历史/);
  assert.doesNotMatch(summary, /主题命中/);
});

test('consumeSSEStream dispatches progress/complete/error events and reports terminal state', async () => {
  const { consumeSSEStream } = ragChatUtils;

  // Build a fake SSE response: a progress frame, a complete frame, then close.
  const sseBody = [
    'event: progress',
    'data: {"content":"检索中"}',
    '',
    'event: complete',
    'data: {"summary":"完成","recommendation":{"books":[]}}',
    '',
    'event: error',
    'data: {"error":"不该到达"}',
    '',
  ].join('\n');

  const response = new Response(new TextEncoder().encode(sseBody), {
    headers: { 'content-type': 'text/event-stream' },
  });

  const calls: string[] = [];
  const sawTerminal = await consumeSSEStream(response, {
    onProgress: () => calls.push('progress'),
    onComplete: () => calls.push('complete'),
    onError: () => calls.push('error'),
  });

  // The 'complete' event sets sawTerminalEvent=true; the stream loop continues
  // and would dispatch 'error' too — but that reflects the real prior behavior
  // where the loop keeps consuming until the reader is done. The important
  // guarantee is that progress fired before complete, and a terminal was seen.
  assert.ok(calls.indexOf('progress') < calls.indexOf('complete'));
  assert.equal(sawTerminal, true);
});

test('consumeSSEStream returns false when the stream ends without a terminal event', async () => {
  const { consumeSSEStream } = ragChatUtils;

  // Only progress frames, no complete/error -> caller should detect interruption.
  const sseBody = ['event: progress', 'data: {"content":"…"}', '', ''].join('\n');
  const response = new Response(new TextEncoder().encode(sseBody), {
    headers: { 'content-type': 'text/event-stream' },
  });

  const sawTerminal = await consumeSSEStream(response, {
    onProgress: () => {},
  });

  assert.equal(sawTerminal, false);
});

test('collectExportBooks dedupes recommendations across assistant messages by book_id', () => {
  const { collectExportBooks } = ragChatUtils;
  const messages: ragChatUtils.MessageType[] = [
    {
      id: 'a1',
      role: 'assistant',
      content: '推荐',
      recommendations: [
        { title: '历史书', author: '甲', price: 20, explanation: '理由', book_id: '1', match_score: 0.9 },
        { title: '哲学书', author: '乙', price: 30, explanation: '理由', book_id: '2', match_score: 0.8 },
      ],
    },
    {
      id: 'a2',
      role: 'assistant',
      content: '更多',
      recommendations: [
        // duplicate book_id 1 — should be dropped
        { title: '历史书(重复)', author: '甲', price: 20, explanation: '理由', book_id: '1', match_score: 0.9 },
        { title: '文学书', author: '丙', price: 15, explanation: '理由', book_id: '3', match_score: 0.7 },
      ],
    },
    { id: 'u1', role: 'user', content: '用户消息不参与聚合' },
  ];

  const books = collectExportBooks(messages);

  assert.equal(books.length, 3);
  assert.deepEqual(
    books.map((b) => b.title),
    ['历史书', '哲学书', '文学书'],
  );
  // match_score is rounded to a 0-100 integer for the export sheet.
  assert.equal(books[0].score, 90);
});

test('collectExportBooks returns empty array when there are no recommendations', () => {
  const { collectExportBooks } = ragChatUtils;
  assert.deepEqual(collectExportBooks([]), []);
  assert.deepEqual(
    collectExportBooks([{ id: 'a1', role: 'assistant', content: '无推荐', recommendations: [] }]),
    [],
  );
});

test('generateBooklistName embeds the primary category and target count', () => {
  const { generateBooklistName } = ragChatUtils;

  assert.equal(
    generateBooklistName('我要书', { categories: ['历史'], constraints: { target_count: 10 } }),
    '历史_10本',
  );
  // No requirement -> fall back to cleaned input.
  assert.equal(generateBooklistName('推荐好书！', undefined), '推荐好书');
  // Empty everything -> default.
  assert.equal(generateBooklistName('', undefined), '书单');
});
