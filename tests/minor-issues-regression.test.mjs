import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();

function source(path) {
  return readFileSync(resolve(root, path), 'utf8');
}

test('health endpoint exposes self-test dependency flags', () => {
  const healthRoute = source('app/api/health/route.ts');

  assert.match(healthRoute, /hasDatabaseConfig/);
  assert.match(healthRoute, /hasRedisConfig/);
  assert.match(healthRoute, /^\s+database(?=,|:)/m);
  assert.match(healthRoute, /dependencies:/);
  assert.doesNotMatch(healthRoute, /getFilterStatus/);
  assert.match(healthRoute, /postgres-keyword/);
});

test('service fetches use bounded timeout helpers', () => {
  const authClient = source('lib/clients/auth-client.ts');
  const catalogRepository = source('lib/server/catalog-repository.ts');
  const fetchTimeout = source('lib/utils/fetch-timeout.ts');

  assert.match(fetchTimeout, /fetchWithTimeout/);
  assert.match(fetchTimeout, /AbortController/);
  assert.doesNotMatch(authClient, /\bfetch\(/);
  assert.doesNotMatch(catalogRepository, /\bfetch\(/);
  assert.match(authClient, /fetchWithTimeout/);
});

test('catalog search uses the shared OR text-search builder', () => {
  const catalogRepository = source('lib/server/catalog-repository.ts');

  assert.match(catalogRepository, /buildCatalogTextSearch/);
  assert.match(catalogRepository, /search_terms/);
  assert.doesNotMatch(catalogRepository, /textConditions\.join\(['"] AND ['"]\)/);
});

test('query preparation UI exposes confirmation, strategy, templates, and manual exclusions', () => {
  const ragChat = source('components/rag-chat.tsx');
  const sidebar = source('components/RAGChat/SidebarContent.tsx');
  const tuningPanel = source('components/RAGChat/TuningPanel.tsx');

  assert.match(ragChat, /本轮策略/);
  assert.match(ragChat, /确认调整/);
  // The "save as template" affordance now lives in the extracted SidebarContent component.
  assert.match(sidebar, /保存为需求模板/);
  assert.match(ragChat, /buildPseudoSql/);
  assert.match(tuningPanel, /添加排除词/);
  assert.match(tuningPanel, /碰撞建议/);
});

test('rag parse endpoint and chat endpoint support precomputed requirements', () => {
  const parseRoute = source('app/api/rag/parse/route.ts');
  const chatRoute = source('app/api/rag/chat/route.ts');

  assert.match(parseRoute, /analyzeRequirement/);
  assert.match(parseRoute, /suggestions/);
  assert.match(chatRoute, /confirmedRequirement/);
  assert.match(chatRoute, /requirement:\s*confirmedRequirement/);
});

test('conversation memory accepts Upstash object responses and chat requests are bounded', () => {
  const conversationMemory = source('lib/conversation/conversation-memory.ts');
  const ragChat = source('components/rag-chat.tsx');
  const requirementAgent = source('lib/agents/requirement-agent.ts');

  assert.match(conversationMemory, /parseStoredSession/);
  assert.match(conversationMemory, /typeof raw === ['"]string['"]/);
  assert.match(conversationMemory, /typeof parsed !== ['"]object['"]/);
  assert.match(ragChat, /CHAT_REQUEST_TIMEOUT_MS/);
  assert.match(ragChat, /controller\.abort\(\)/);
  assert.match(ragChat, /clearTimeout\(timeoutId\)/);
  assert.match(requirementAgent, /maxRetries:\s*0/);
});

test('persisted streaming messages are recovered after page refresh', () => {
  const ragChat = source('components/rag-chat.tsx');
  const ragChatUtils = source('components/rag-chat-utils.ts');

  assert.match(ragChatUtils, /recoverInterruptedMessages/);
  assert.match(ragChat, /recoverInterruptedMessages\(session\.messages/);
  assert.match(ragChat, /localStorage\.setItem\(['"]rag-chat-sessions['"]/);
});

test('keyword retrieval falls back when an exact search returns no books', () => {
  const retrievalAgent = source('lib/agents/retrieval-agent.ts');

  assert.match(retrievalAgent, /popular-fallback/);
  assert.match(retrievalAgent, /books\.length === 0/);
  assert.match(retrievalAgent, /retrievePopular/);
});

test('settings separate model and appearance controls and cards never invent a match score', () => {
  const settings = source('components/RAGChat/LLMSettingsDialog.tsx');
  const bookCard = source('components/RAGChat/BookCard.tsx');
  const layout = source('app/layout.tsx');

  assert.match(settings, /模型配置/);
  assert.match(settings, /外观/);
  assert.match(settings, /跟随系统/);
  assert.match(settings, />设置</);
  assert.doesNotMatch(bookCard, /:\s*90/);
  assert.match(layout, /suppressHydrationWarning/);
});
