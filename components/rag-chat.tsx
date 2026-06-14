'use client';

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import {
  attachRemoteSessionId,
  recoverInterruptedMessages,
  normalizeBookRecommendations,
  normalizeRequirementSnapshot,
  consumeSSEStream,
  collectExportBooks,
  generateBooklistName,
  type MessageType,
  type SessionItem,
} from '@/components/rag-chat-utils';
import { RAGChatHeader } from '@/components/RAGChat/RAGChatHeader';
import { StarterPrompts } from '@/components/RAGChat/StarterPrompts';
import { MessageList } from '@/components/RAGChat/MessageList';
import { ChatInput } from '@/components/RAGChat/ChatInput';
import { Toast } from '@/components/RAGChat/Toast';
import { TuningPanel } from '@/components/RAGChat/TuningPanel';
import { SidebarContent } from '@/components/RAGChat/SidebarContent';
import {
  buildPseudoSql,
  findExactTemplate,
  normalizeRequirementText,
  type RequirementTemplate,
} from '@/components/query-preparation';
import type { RequirementAnalysis } from '@/lib/types/rag';
import { Menu, X, Sliders, FileSearch } from 'lucide-react';
import type { LLMProviderConfig } from '@/lib/config/provider-config';
import { loadProviderConfig, saveProviderConfig } from '@/lib/config/provider-config';

const CHAT_REQUEST_TIMEOUT_MS = 30_000;

export function RAGChat() {
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  const [messages, setMessages] = useState<MessageType[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Custom Tuning parameters:
  const [targetCount, setTargetCount] = useState(15);
  const [categoryWeight, setCategoryWeight] = useState(1.2);
  const [keywordWeight, setKeywordWeight] = useState(0.6);
  const [selectedExclusions, setSelectedExclusions] = useState<string[]>([]);
  const [selectedKeywords, setSelectedKeywords] = useState<string[]>([]);
  const [lastSql, setLastSql] = useState<string | undefined>(undefined);
  const [templates, setTemplates] = useState<RequirementTemplate[]>([]);
  const [preparedQuery, setPreparedQuery] = useState('');
  const [draftRequirement, setDraftRequirement] = useState<RequirementAnalysis | null>(null);
  const [confirmedRequirement, setConfirmedRequirement] = useState<RequirementAnalysis | null>(null);
  const [isDraftConfirmed, setIsDraftConfirmed] = useState(false);

  const [strategy, setStrategy] = useState<{ type: 'ai' | 'template'; label: string; detail: string } | null>(null);
  const [isPreparing, setIsPreparing] = useState(false);
  const [libraryCategory, setLibraryCategory] = useState<string>('none');
  const [availableCategories, setAvailableCategories] = useState<{ code: string; name: string; keyword_count: number }[]>([]);
  const [loadingCategory, setLoadingCategory] = useState(false);
  const [llmProvider, setLlmProvider] = useState<LLMProviderConfig>({ type: 'openai-compatible' as const, apiKey: '', model: 'gemini-2.0-flash' });

  useEffect(() => {
    setLlmProvider(loadProviderConfig());
  }, []);

  const handleProviderSave = useCallback((config: LLMProviderConfig) => {
    setLlmProvider(config);
    saveProviderConfig(config);
  }, []);

  // Mobile UI drawers state:
  const [showLeftDrawer, setShowLeftDrawer] = useState(false);
  const [showRightDrawer, setShowRightDrawer] = useState(false);

  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    try {
      setTemplates(JSON.parse(localStorage.getItem('rag-requirement-templates') || '[]'));
    } catch {
      setTemplates([]);
    }
  }, []);

  // 加载可用的馆别列表
  useEffect(() => {
    const loadCategories = async () => {
      try {
        const res = await fetch('/api/admin/library-categories');
        if (res.ok) {
          const data = await res.json();
          setAvailableCategories(data.categories || []);
        }
      } catch (err) {
        console.error('Failed to load library categories:', err);
      }
    };
    loadCategories();
  }, []);

  // Load sessions from localStorage on mount
  useEffect(() => {
    const stored = localStorage.getItem('rag-chat-sessions');
    const storedActiveId = localStorage.getItem('rag-active-session-id');

    let parsedSessions: SessionItem[] = [];
    if (stored) {
      try {
        const storedSessions = JSON.parse(stored) as SessionItem[];
        parsedSessions = storedSessions.map((session) => ({
          ...session,
          messages: recoverInterruptedMessages(session.messages || []),
        }));
        localStorage.setItem('rag-chat-sessions', JSON.stringify(parsedSessions));
      } catch (e) {
        console.error('Failed to parse sessions from local storage', e);
      }
    }

    if (parsedSessions.length === 0) {
      const newSessId = crypto.randomUUID();
      const defaultSession: SessionItem = {
        id: newSessId,
        title: '新推荐会话',
        messages: [],
        lastSql: undefined,
        targetCount: 15,
        categoryWeight: 1.2,
        keywordWeight: 0.6,
        selectedExclusions: [],
        libraryCategory: 'none',
      };
      parsedSessions = [defaultSession];
      localStorage.setItem('rag-chat-sessions', JSON.stringify(parsedSessions));
      localStorage.setItem('rag-active-session-id', newSessId);
      setSessions(parsedSessions);
      setActiveSessionId(newSessId);
    } else {
      setSessions(parsedSessions);
      if (storedActiveId && parsedSessions.some(s => s.id === storedActiveId)) {
        setActiveSessionId(storedActiveId);
      } else {
        const fallbackId = parsedSessions[0].id;
        setActiveSessionId(fallbackId);
        localStorage.setItem('rag-active-session-id', fallbackId);
      }
    }
  }, []);

  // Sync state with active session
  useEffect(() => {
    if (!activeSessionId || sessions.length === 0) return;
    const activeSession = sessions.find(s => s.id === activeSessionId);
    if (activeSession) {
      setMessages(activeSession.messages || []);
      setLastSql(activeSession.lastSql);
      setTargetCount(activeSession.targetCount ?? 15);
      setCategoryWeight(activeSession.categoryWeight ?? 1.2);
      setKeywordWeight(activeSession.keywordWeight ?? 0.6);
      setSelectedExclusions(activeSession.selectedExclusions ?? []);
      setSelectedKeywords(activeSession.selectedKeywords ?? []);
      const cat = activeSession.libraryCategory ?? 'none';
      setLibraryCategory(cat);
      setSessionId(activeSession.remoteSessionId ?? activeSession.id);
    }
  }, [activeSessionId, sessions]);

  // Update helper
  const updateActiveSession = useCallback((updates: Partial<SessionItem>) => {
    if (!activeSessionId) return;
    setSessions((prevSessions) => {
      const updated = prevSessions.map((sess) => {
        if (sess.id === activeSessionId) {
          return {
            ...sess,
            ...updates,
          };
        }
        return sess;
      });
      localStorage.setItem('rag-chat-sessions', JSON.stringify(updated));
      return updated;
    });
  }, [activeSessionId]);

  const handleCreateSession = useCallback(() => {
    const newSessId = crypto.randomUUID();
    const newSession: SessionItem = {
      id: newSessId,
      title: '新推荐会话',
      messages: [],
      lastSql: undefined,
      targetCount: 15,
      categoryWeight: 1.2,
      keywordWeight: 0.6,
      selectedExclusions: [],
      libraryCategory: 'none',
    };

    setSessions((prev) => {
      const updated = [newSession, ...prev];
      localStorage.setItem('rag-chat-sessions', JSON.stringify(updated));
      return updated;
    });
    setActiveSessionId(newSessId);
    localStorage.setItem('rag-active-session-id', newSessId);
    setMessages([]);
    setLastSql(undefined);
    setTargetCount(15);
    setCategoryWeight(1.2);
    setKeywordWeight(0.6);
    setSelectedExclusions([]);
    setLibraryCategory('none');
    setSessionId(newSessId);
  }, []);

  const handleSwitchSession = useCallback((id: string) => {
    setActiveSessionId(id);
    localStorage.setItem('rag-active-session-id', id);
  }, []);

  const handleDeleteSession = useCallback((id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm('确认删除该推荐会话吗？')) {
      setSessions((prev) => {
        let updated = prev.filter(s => s.id !== id);
        const nextActiveId = updated[0]?.id || crypto.randomUUID();
        if (updated.length === 0) {
          updated = [{
            id: nextActiveId,
            title: '新推荐会话',
            messages: [],
            lastSql: undefined,
            targetCount: 15,
            categoryWeight: 1.2,
            keywordWeight: 0.6,
            selectedExclusions: [],
            libraryCategory: 'none',
          }];
        }
        localStorage.setItem('rag-chat-sessions', JSON.stringify(updated));

        if (activeSessionId === id) {
          setActiveSessionId(updated[0]?.id || nextActiveId);
          localStorage.setItem('rag-active-session-id', updated[0]?.id || nextActiveId);
        }
        return updated;
      });
    }
  }, [activeSessionId]);

  const handleTargetCountChange = (val: number) => {
    setTargetCount(val);
    setConfirmedRequirement(null);
    setIsDraftConfirmed(false);
    setDraftRequirement((current) => current ? {
      ...current,
      constraints: { ...current.constraints, target_count: val },
    } : current);
    updateActiveSession({ targetCount: val });
  };

  const handleCategoryWeightChange = (val: number) => {
    setCategoryWeight(val);
    setConfirmedRequirement(null);
    setIsDraftConfirmed(false);
    updateActiveSession({ categoryWeight: val });
  };

  const handleKeywordWeightChange = (val: number) => {
    setKeywordWeight(val);
    setConfirmedRequirement(null);
    setIsDraftConfirmed(false);
    updateActiveSession({ keywordWeight: val });
  };

  const handleExclusionsChange = (val: string[]) => {
    setSelectedExclusions(val);
    setConfirmedRequirement(null);
    setIsDraftConfirmed(false);
    setDraftRequirement((current) => current ? {
      ...current,
      constraints: { ...current.constraints, exclude_keywords: val },
    } : current);
    updateActiveSession({ selectedExclusions: val });
  };

  const handleKeywordsChange = (val: string[]) => {
    setSelectedKeywords(val);
    setConfirmedRequirement(null);
    setIsDraftConfirmed(false);
    setDraftRequirement((current) => current ? {
      ...current,
      keywords: val,
      expanded_search_terms: val,
    } : current);
    updateActiveSession({ selectedKeywords: val });
  };

  const handleLibraryCategoryChange = useCallback(async (val: string) => {
    setLibraryCategory(val);
    updateActiveSession({ libraryCategory: val });
    
    // 自动加载该馆别的屏蔽词
    if (val && val !== 'none') {
      setLoadingCategory(true);
      try {
        const res = await fetch(`/api/rag/exclusions?library_code=${encodeURIComponent(val)}`);
        if (res.ok) {
          const data = await res.json();
          const keywords = data.keywords || [];
          setSelectedExclusions(keywords);
          setConfirmedRequirement(null);
          setIsDraftConfirmed(false);
          setDraftRequirement((current) => current ? {
            ...current,
            constraints: { ...current.constraints, exclude_keywords: keywords },
          } : current);
          updateActiveSession({ selectedExclusions: keywords });
        }
      } catch (err) {
        console.error('Failed to load exclusion keywords:', err);
        setToastMessage('加载屏蔽词失败');
        setTimeout(() => setToastMessage(null), 3000);
      } finally {
        setLoadingCategory(false);
      }
    } else {
      // 清空屏蔽词
      setSelectedExclusions([]);
      updateActiveSession({ selectedExclusions: [] });
    }
  }, [updateActiveSession]);

  const handleAddCustomExclusion = useCallback(async (word: string) => {
    const trimmedWord = word.trim();
    if (!trimmedWord) return;

    if (!selectedExclusions.includes(trimmedWord)) {
      const newExclusions = [...selectedExclusions, trimmedWord];
      setSelectedExclusions(newExclusions);
      setConfirmedRequirement(null);
      setIsDraftConfirmed(false);
      setDraftRequirement((current) => current ? {
        ...current,
        constraints: { ...current.constraints, exclude_keywords: newExclusions },
      } : current);
      updateActiveSession({ selectedExclusions: newExclusions });
    }

    if (libraryCategory && libraryCategory !== 'none') {
      try {
        const res = await fetch('/api/rag/exclusions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            keyword: trimmedWord,
            library_code: libraryCategory,
            action: 'add',
          }),
        });
        if (!res.ok) {
          throw new Error(`Failed to persist: ${res.statusText}`);
        }
      } catch (err) {
        console.error('Failed to save exclusion to database:', err);
        setToastMessage('保存屏蔽词到数据库失败');
        setTimeout(() => setToastMessage(null), 3000);
      }
    }
  }, [selectedExclusions, libraryCategory, updateActiveSession]);

  const handleToggleExclusion = useCallback(async (word: string, isSelected: boolean) => {
    const newExclusions = isSelected
      ? selectedExclusions.filter((item) => item !== word)
      : [...selectedExclusions, word];

    setSelectedExclusions(newExclusions);
    setConfirmedRequirement(null);
    setIsDraftConfirmed(false);
    setDraftRequirement((current) => current ? {
      ...current,
      constraints: { ...current.constraints, exclude_keywords: newExclusions },
    } : current);
    updateActiveSession({ selectedExclusions: newExclusions });

    if (libraryCategory && libraryCategory !== 'none') {
      try {
        const res = await fetch('/api/rag/exclusions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            keyword: word,
            library_code: libraryCategory,
            action: isSelected ? 'remove' : 'add',
          }),
        });
        if (!res.ok) {
          throw new Error(`Failed to persist: ${res.statusText}`);
        }
      } catch (err) {
        console.error('Failed to update exclusion in database:', err);
        setToastMessage('更新数据库屏蔽词失败');
        setTimeout(() => setToastMessage(null), 3000);
      }
    }
  }, [selectedExclusions, libraryCategory, updateActiveSession]);

  const handleResetSession = useCallback(() => {
    if (confirm('确认清空当前对话上下文并重新开始？')) {
      setMessages([]);
      setLastSql(undefined);
      setTargetCount(15);
      setCategoryWeight(1.2);
      setKeywordWeight(0.6);
      setSelectedExclusions([]);
      setSelectedKeywords([]);
      setLibraryCategory('none');
      setPreparedQuery('');
      setDraftRequirement(null);
      setConfirmedRequirement(null);
      setIsDraftConfirmed(false);
      setStrategy(null);
      updateActiveSession({
        messages: [],
        remoteSessionId: undefined,
        lastSql: undefined,
        targetCount: 15,
        categoryWeight: 1.2,
        keywordWeight: 0.6,
        selectedExclusions: [],
        selectedKeywords: [],
        libraryCategory: 'none',
        title: '新推荐会话',
      });
    }
  }, [updateActiveSession]);

  const applyPreparedRequirement = useCallback((
    query: string,
    requirement: RequirementAnalysis,
    exclusions: string[],
    nextStrategy: { type: 'ai' | 'template'; label: string; detail: string },
  ) => {
    const inferredCat = requirement.inferred_library_type || 'none';
    const nextRequirement = {
      ...requirement,
      original_query: query,
      constraints: {
        ...requirement.constraints,
        target_count: requirement.constraints.target_count ?? targetCount,
        exclude_keywords: exclusions,
      },
    };
    setPreparedQuery(query);
    setDraftRequirement(nextRequirement);
    setConfirmedRequirement(null);
    setIsDraftConfirmed(false);
    setSelectedExclusions(exclusions);
    setSelectedKeywords([...new Set([
      ...(requirement.keywords || []),
      ...(requirement.expanded_search_terms || []),
    ])]);
    setTargetCount(nextRequirement.constraints.target_count ?? targetCount);
    setLibraryCategory(inferredCat);
    setStrategy(nextStrategy);
    setInput('');

    updateActiveSession({
      selectedExclusions: exclusions,
      selectedKeywords: [...new Set([
        ...(requirement.keywords || []),
        ...(requirement.expanded_search_terms || []),
      ])],
      targetCount: nextRequirement.constraints.target_count ?? targetCount,
      libraryCategory: inferredCat,
    });
  }, [targetCount, updateActiveSession]);

  const prepareRequirement = useCallback(async (rawQuery: string, forceAi = false) => {
    const query = rawQuery.trim();
    if (!query || isPreparing || isLoading) return;

    const matchedTemplate = forceAi ? undefined : findExactTemplate(query, templates);
    if (matchedTemplate) {
      setCategoryWeight(matchedTemplate.categoryWeight);
      setKeywordWeight(matchedTemplate.keywordWeight);
      applyPreparedRequirement(
        query,
        matchedTemplate.requirement,
        matchedTemplate.requirement.constraints.exclude_keywords ?? [],
        {
          type: 'template',
          label: `需求模板直用：${matchedTemplate.name}`,
          detail: `标准化文本精确命中，已跳过 LLM 解析 · 更新于 ${new Date(matchedTemplate.updatedAt).toLocaleDateString('zh-CN')}`,
        },
      );
      return;
    }

    setIsPreparing(true);
    try {
      const response = await fetch('/api/rag/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query,
          llmProvider: llmProvider.apiKey ? llmProvider : undefined,
        }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const suggestions = Array.isArray(data.suggestions) ? data.suggestions : [];
      const usedFallback = data.strategy === 'local-fallback';
      applyPreparedRequirement(query, data.requirement, suggestions, {
        type: 'ai',
        label: usedFallback ? '本地规则降级解析' : 'AI 需求解析',
        detail: usedFallback
          ? 'LLM 当前不可用，本轮使用本地规则提取需求；请重点检查查询草稿。'
          : '本轮已调用需求分析模型。请检查右侧草稿与中间查询预览。',
      });
    } catch (error) {
      console.error('Failed to prepare requirement:', error);
      setToastMessage('需求解析失败，请稍后重试');
      setTimeout(() => setToastMessage(null), 4000);
    } finally {
      setIsPreparing(false);
    }
  }, [applyPreparedRequirement, isLoading, isPreparing, templates, llmProvider]);

  const confirmAdjustments = useCallback(() => {
    if (!draftRequirement) return;
    const confirmed = {
      ...draftRequirement,
      keywords: selectedKeywords,
      expanded_search_terms: selectedKeywords,
      constraints: {
        ...draftRequirement.constraints,
        target_count: targetCount,
        exclude_keywords: selectedExclusions,
      },
    };
    setConfirmedRequirement(confirmed);
    setDraftRequirement(confirmed);
    setIsDraftConfirmed(true);
  }, [draftRequirement, selectedExclusions, selectedKeywords, targetCount]);

  const saveSessionAsTemplate = useCallback((session: SessionItem) => {
    if (!draftRequirement || !preparedQuery) {
      setToastMessage('请先解析并确认一个需求');
      setTimeout(() => setToastMessage(null), 3000);
      return;
    }
    const name = window.prompt('模板名称', session.title || '新需求模板')?.trim();
    if (!name) return;
    const nextTemplate: RequirementTemplate = {
      id: crypto.randomUUID(),
      name,
      sourceText: preparedQuery,
      normalizedText: normalizeRequirementText(preparedQuery),
      requirement: {
        ...(confirmedRequirement ?? draftRequirement),
        constraints: {
          ...(confirmedRequirement ?? draftRequirement).constraints,
          target_count: targetCount,
          exclude_keywords: selectedExclusions,
        },
      },
      categoryWeight,
      keywordWeight,
      updatedAt: new Date().toISOString(),
    };
    setTemplates((current) => {
      const updated = [nextTemplate, ...current.filter((item) => item.normalizedText !== nextTemplate.normalizedText)];
      localStorage.setItem('rag-requirement-templates', JSON.stringify(updated));
      return updated;
    });
  }, [categoryWeight, confirmedRequirement, draftRequirement, keywordWeight, preparedQuery, selectedExclusions, targetCount]);



  const upsertAssistantMessage = useCallback(
    (assistantMessageId: string, updater: (current?: MessageType) => MessageType) => {
      setMessages((prev) => {
        const existingIndex = prev.findIndex((message) => message.id === assistantMessageId);
        let updated: MessageType[];
        if (existingIndex !== -1) {
          updated = [...prev];
          updated[existingIndex] = updater(updated[existingIndex]);
        } else {
          updated = [...prev, updater(undefined)];
        }
        updateActiveSession({ messages: updated });
        return updated;
      });
    },
    [updateActiveSession]
  );

  const handleExportExcel = useCallback(async (currentMessage: MessageType) => {
    if (exporting) return;
    setExporting(true);

    try {
      const allBooks = collectExportBooks(messages);

      if (allBooks.length === 0) {
        setToastMessage('没有可导出的书籍');
        setTimeout(() => setToastMessage(null), 4000);
        return;
      }

      const totalPrice = allBooks.reduce((sum, b) => sum + (b.price || 0), 0);
      const booklistName = generateBooklistName(currentMessage.content, currentMessage.requirement);

      const res = await fetch('/api/v1/book-list/export-excel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          booklist_name: booklistName,
          books: allBooks,
          budget: currentMessage.requirement?.constraints?.budget ?? null,
          total_price: totalPrice,
        }),
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || `导出失败：HTTP ${res.status}`);
      }

      const blob = await res.blob();
      const disposition = res.headers.get('Content-Disposition') || '';
      const match = disposition.match(/filename\*=UTF-8''(.+)/);
      const filename = match ? decodeURIComponent(match[1]) : '书单.xlsx';

      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : '导出失败，请重试';
      setToastMessage(errorMessage);
      setTimeout(() => setToastMessage(null), 4000);
    } finally {
      setExporting(false);
    }
  }, [messages, exporting]);

  const submitQuery = useCallback(async (rawInput: string, prepared?: RequirementAnalysis) => {
    const trimmed = rawInput.trim();
    if (!trimmed || isLoading) return;

    const userMessage: MessageType = {
      id: crypto.randomUUID(),
      role: 'user',
      content: trimmed,
      status: 'done',
    };
    const assistantMessageId = crypto.randomUUID();

    const isFirstMsg = messages.length === 0;
    const newTitle = isFirstMsg
      ? (trimmed.slice(0, 12) + (trimmed.length > 12 ? '...' : ''))
      : undefined;

    const streamingMsg: MessageType = {
      id: assistantMessageId,
      role: 'assistant',
      content: '正在为您梳理需求，调取书库检索...',
      status: 'streaming',
    };

    setMessages((prev) => {
      const updated = [...prev, userMessage, streamingMsg];
      updateActiveSession({
        messages: updated,
        ...(newTitle ? { title: newTitle } : {}),
      });
      return updated;
    });

    setInput('');
    setDraftRequirement(null);
    setIsLoading(true);
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;
      timeoutId = setTimeout(() => controller.abort(), CHAT_REQUEST_TIMEOUT_MS);

      const response = await fetch('/api/rag/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: trimmed,
          sessionId: sessionId || undefined,
          limit: targetCount,
          excludeKeywords: selectedExclusions,
          categoryWeight: categoryWeight,
          keywordWeight: keywordWeight,
          confirmedRequirement: prepared,
          llmProvider: llmProvider.apiKey ? llmProvider : undefined,
          libraryCategory: libraryCategory !== 'none' ? libraryCategory : undefined,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const data = await response.json();
        const recommendations = normalizeBookRecommendations(
          (data.recommendation?.books || []) as Array<Record<string, unknown>>,
          { normalizeScore: true },
        );
        const requirement = data.requirement
          ? normalizeRequirementSnapshot(data.requirement as Record<string, unknown>)
          : undefined;

        const sqlFromResp = data.retrieval?.sql;
        if (sqlFromResp) {
          setLastSql(sqlFromResp);
          setTimeout(() => updateActiveSession({ lastSql: sqlFromResp }), 0);
        }

        if (data.sessionId && data.sessionId !== sessionId) {
          setSessions((prev) => {
            const updated = prev.map((s) => {
              if (s.id === activeSessionId) {
                return attachRemoteSessionId(s, data.sessionId);
              }
              return s;
            });
            localStorage.setItem('rag-chat-sessions', JSON.stringify(updated));
            return updated;
          });
          setSessionId(data.sessionId);
        }

        upsertAssistantMessage(assistantMessageId, () => ({
          id: assistantMessageId, role: 'assistant',
          content: data.summary || (recommendations.length > 0 ? '推荐已生成。' : '这次没找到合适的推荐结果。'),
          recommendations,
          requirement,
          totalPrice: typeof data.recommendation?.total_price === 'number' ? data.recommendation.total_price : undefined,
          sessionId: data.sessionId || sessionId || undefined,
          status: data.success ? 'done' : 'error',
        }));

        setIsLoading(false);
        return;
      }

      const sawTerminalEvent = await consumeSSEStream(response, {
        onProgress: (data) => {
          const sqlFromResp = (data.data as { sql?: string } | undefined)?.sql;
          if (sqlFromResp) {
            setLastSql(sqlFromResp);
            setTimeout(() => updateActiveSession({ lastSql: sqlFromResp }), 0);
          }
          upsertAssistantMessage(assistantMessageId, (current) => ({
            id: assistantMessageId, role: 'assistant',
            content: (data.content as string) || current?.content || '正在处理你的请求...',
            recommendations: current?.recommendations,
            requirement: current?.requirement,
            totalPrice: current?.totalPrice,
            sessionId: current?.sessionId,
            status: 'streaming',
          }));
        },
        onComplete: (data) => {
          const recommendations = normalizeBookRecommendations(
            ((data.recommendation as { books?: Array<Record<string, unknown>> } | undefined)?.books || []) as Array<Record<string, unknown>>,
            { normalizeScore: true },
          );
          const requirement = data.requirement
            ? normalizeRequirementSnapshot(data.requirement as Record<string, unknown>)
            : undefined;

          const sqlFromResp = (data.retrieval as { sql?: string } | undefined)?.sql;
          if (sqlFromResp) {
            setLastSql(sqlFromResp);
            setTimeout(() => updateActiveSession({ lastSql: sqlFromResp }), 0);
          }

          if (data.sessionId && data.sessionId !== sessionId) {
            setSessions((prev) => {
              const updated = prev.map((s) => {
                if (s.id === activeSessionId) {
                  return attachRemoteSessionId(s, data.sessionId as string);
                }
                return s;
              });
              localStorage.setItem('rag-chat-sessions', JSON.stringify(updated));
              return updated;
            });
            setSessionId(data.sessionId as string);
          }

          upsertAssistantMessage(assistantMessageId, () => ({
            id: assistantMessageId, role: 'assistant',
            content: (data.summary as string) || (recommendations.length > 0 ? '推荐已生成。' : '这次没找到合适的推荐结果。'),
            recommendations,
            requirement,
            totalPrice: typeof (data.recommendation as { total_price?: number } | undefined)?.total_price === 'number' ? (data.recommendation as { total_price?: number }).total_price : undefined,
            sessionId: (data.sessionId as string) || sessionId || undefined,
            status: 'done',
          }));

          setIsLoading(false);
        },
        onError: (data) => {
          upsertAssistantMessage(assistantMessageId, () => ({
            id: assistantMessageId, role: 'assistant',
            content: (data.error as string) || '抱歉，处理你的请求时出错了。你可以换个说法再试一次。',
            status: 'error',
          }));
          setIsLoading(false);
        },
      });

      if (!sawTerminalEvent) {
        throw new Error('服务响应被意外中断，请稍后重试');
      }
    } catch (error) {
      console.error('Error:', error);
      setIsLoading(false);
      const isTimeout = error instanceof DOMException && error.name === 'AbortError';
      upsertAssistantMessage(assistantMessageId, () => ({
        id: assistantMessageId, role: 'assistant',
        content: isTimeout
          ? '查询等待超时，已自动停止。请重试，系统会创建新的会话继续处理。'
          : '抱歉，处理你的请求时出错了。你可以稍后重试，或者换个更具体的需求。',
        status: 'error',
      }));
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      abortControllerRef.current = null;
    }
  }, [isLoading, activeSessionId, sessionId, targetCount, selectedExclusions, categoryWeight, keywordWeight, upsertAssistantMessage, updateActiveSession, messages.length, llmProvider, libraryCategory]);

  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    prepareRequirement(input);
  }, [input, prepareRequirement]);

  const handleStarterSelect = useCallback((prompt: string) => {
    setInput(prompt);
    setTimeout(() => prepareRequirement(prompt), 0);
  }, [prepareRequirement]);



  const pseudoSql = useMemo(
    () => draftRequirement ? buildPseudoSql(draftRequirement, categoryWeight, keywordWeight) : '',
    [categoryWeight, draftRequirement, keywordWeight],
  );

  const handleApplyTemplate = useCallback((template: RequirementTemplate) => {
    setCategoryWeight(template.categoryWeight);
    setKeywordWeight(template.keywordWeight);
    applyPreparedRequirement(
      template.sourceText,
      template.requirement,
      template.requirement.constraints.exclude_keywords ?? [],
      {
        type: 'template',
        label: `手动采用模板：${template.name}`,
        detail: '用户手动选择模板，已跳过 LLM 解析。',
      },
    );
  }, [applyPreparedRequirement]);

  const renderSidebarContent = (onClose?: () => void) => (
    <SidebarContent
      sessions={sessions}
      activeSessionId={activeSessionId}
      templates={templates}
      llmProvider={llmProvider}
      onCreateSession={handleCreateSession}
      onSwitchSession={handleSwitchSession}
      onDeleteSession={handleDeleteSession}
      onSaveSessionAsTemplate={saveSessionAsTemplate}
      onApplyTemplate={handleApplyTemplate}
      onProviderSave={handleProviderSave}
      onClose={onClose}
    />
  );

  return (
    <div className="flex h-screen overflow-hidden bg-[#0d0f12] text-slate-100">
      {/* 1. Left Sidebar (Desktop) */}
      <aside className="hidden h-full w-56 shrink-0 border-r border-[#282b31] bg-[#111318] p-4 md:flex md:flex-col md:justify-between">
        {renderSidebarContent()}
      </aside>

      {/* 2. Middle Column (Chat Console) */}
      <main className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-[#0d0f12]">
        {/* Sticky Header */}
        <header className="sticky top-0 z-30 flex shrink-0 items-center justify-between border-b border-[#282b31] bg-[#101216] px-5 py-3">
          <div className="flex items-center gap-2.5">
            <div>
              <h2 className="text-sm md:text-base font-bold text-slate-100 tracking-tight leading-none">
                {sessions.find(s => s.id === activeSessionId)?.title || '新推荐会话'}
              </h2>
              <div className="flex items-center gap-1.5 mt-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                <span className="text-[10px] text-slate-500 font-mono">{llmProvider.model || 'LLM'} RAG Engine v1.2</span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowLeftDrawer(true)}
              className="md:hidden p-2 rounded-xl bg-slate-900 border border-slate-800/80 text-slate-400 hover:text-slate-200 transition-all active:scale-95"
            >
              <Menu className="w-4 h-4" />
            </button>
            <button
              onClick={() => setShowRightDrawer(true)}
              className="lg:hidden p-2 rounded-xl bg-slate-900 border border-slate-800/80 text-slate-400 hover:text-slate-200 transition-all active:scale-95"
            >
              <Sliders className="w-4 h-4" />
            </button>
          </div>
        </header>

        {/* Scrollable Message List / Starter Screen */}
        <div className="flex-1 flex flex-col min-h-0 overflow-y-auto">
          {draftRequirement ? (
            <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col px-5 py-5 md:px-8">
              <section className="strategy-banner">
                <div>
                  <div className="text-xs font-semibold text-amber-200">本轮策略：{strategy?.label}</div>
                  <div className="mt-1 text-[11px] leading-5 text-slate-500">{strategy?.detail}</div>
                </div>
                {strategy?.type === 'template' && (
                  <button type="button" onClick={() => prepareRequirement(preparedQuery, true)} className="text-[11px] text-amber-200 hover:text-amber-100">
                    改用 AI 重新解析
                  </button>
                )}
              </section>

              <section className="workspace-panel mt-4 p-4">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[10px] uppercase tracking-wider text-slate-500">用户需求</span>
                  <button type="button" onClick={() => setInput(preparedQuery)} className="text-[10px] text-slate-500 hover:text-slate-300">编辑</button>
                </div>
                <p className="text-sm leading-6 text-slate-200">{preparedQuery}</p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {draftRequirement.categories.map((item) => <span key={item} className="filter-chip">{item}</span>)}
                  {draftRequirement.keywords.slice(0, 5).map((item) => <span key={item} className="filter-chip">{item}</span>)}
                </div>
              </section>

              <section className="mt-5 flex min-h-0 flex-1 flex-col">
                <div className="mb-2 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <FileSearch className="h-4 w-4 text-amber-300" />
                    <h3 className="text-sm font-semibold text-slate-200">本轮查询预览</h3>
                  </div>
                  <span className="text-[10px] text-slate-500">
                    {isDraftConfirmed ? '已确认，可执行查询' : '随右侧草稿实时更新 · 尚未生效'}
                  </span>
                </div>
                <pre className="sql-preview flex-1">{pseudoSql}</pre>
                <p className="mt-2 border-l-2 border-amber-600/60 bg-amber-500/5 px-3 py-2 text-[11px] leading-5 text-slate-500">
                  右侧调整只会更新预览。点击“确认调整”后，本轮条件才会生效。
                </p>
                <div className="mt-3 flex justify-end gap-2">
                  <button type="button" onClick={confirmAdjustments} className="secondary-action">确认调整</button>
                  <button
                    type="button"
                    disabled={!isDraftConfirmed || !draftRequirement || isLoading}
                    onClick={() => isDraftConfirmed && draftRequirement && submitQuery(preparedQuery, draftRequirement)}
                    className="primary-action"
                  >
                    {isLoading ? '查询中…' : isDraftConfirmed ? '查询' : '查询（请先确认）'}
                  </button>
                </div>
              </section>
            </div>
          ) : messages.length === 0 ? (
            <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center px-5 py-8 md:px-8">
              <RAGChatHeader />
              <StarterPrompts isLoading={isLoading || isPreparing} onSelect={handleStarterSelect} />
            </div>
          ) : (
            <MessageList
              messages={messages}
              exporting={exporting}
              onExport={handleExportExcel}
            />
          )}
        </div>


        {/* Chat Input docked inside Middle Column */}
        <ChatInput
          value={input}
          onChange={(value) => setInput(value)}
          onSubmit={handleSubmit}
          isLoading={isLoading}
        className="z-20 shrink-0 border-t border-[#282b31] bg-[#0d0f12] px-5 py-3"
        />
      </main>

      {/* 3. Right Settings Sidebar (Desktop) */}
      <aside className="hidden h-full w-80 shrink-0 flex-col gap-4 overflow-y-auto border-l border-[#282b31] bg-[#121419] p-4 lg:flex">
        <TuningPanel
          targetCount={targetCount}
          onChangeTargetCount={handleTargetCountChange}
          categoryWeight={categoryWeight}
          onChangeCategoryWeight={handleCategoryWeightChange}
          keywordWeight={keywordWeight}
          onChangeKeywordWeight={handleKeywordWeightChange}
          selectedExclusions={selectedExclusions}
          onChangeExclusions={handleExclusionsChange}
          onAddCustomExclusion={handleAddCustomExclusion}
          onToggleExclusion={handleToggleExclusion}
          suggestedKeywords={draftRequirement?.expanded_search_terms ?? draftRequirement?.keywords}
          selectedKeywords={selectedKeywords}
          onChangeKeywords={handleKeywordsChange}
          lastSql={lastSql}
          onClearSession={handleResetSession}
          libraryCategory={libraryCategory}
          onChangeLibraryCategory={handleLibraryCategoryChange}
          availableCategories={availableCategories}
          loadingCategory={loadingCategory}
        />
      </aside>

      {/* 4. Mobile Drawers */}
      {/* Mobile Left Drawer Overlay */}
      {showLeftDrawer && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 md:hidden flex">
          <div className="w-64 bg-slate-950 border-r border-white/5 p-4 flex flex-col justify-between h-full relative animate-fade-in-up">
            <button
              onClick={() => setShowLeftDrawer(false)}
              className="absolute top-4 right-4 p-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-400 hover:text-slate-200"
            >
              <X className="w-4 h-4" />
            </button>
            {renderSidebarContent(() => setShowLeftDrawer(false))}
          </div>
          <div className="flex-1" onClick={() => setShowLeftDrawer(false)} />
        </div>
      )}

      {/* Mobile Right Drawer Overlay */}
      {showRightDrawer && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 lg:hidden flex justify-end">
          <div className="flex-1" onClick={() => setShowRightDrawer(false)} />
          <div className="w-80 bg-slate-950 border-l border-white/5 p-5 flex flex-col h-full relative animate-fade-in-up">
            <button
              onClick={() => setShowRightDrawer(false)}
              className="absolute top-4 right-4 p-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-400 hover:text-slate-200 z-10"
            >
              <X className="w-4 h-4" />
            </button>
            <div className="pt-8 flex-1 overflow-y-auto min-h-0">
              <TuningPanel
                targetCount={targetCount}
                onChangeTargetCount={handleTargetCountChange}
                categoryWeight={categoryWeight}
                onChangeCategoryWeight={handleCategoryWeightChange}
                keywordWeight={keywordWeight}
                onChangeKeywordWeight={handleKeywordWeightChange}
                selectedExclusions={selectedExclusions}
                onChangeExclusions={handleExclusionsChange}
                onAddCustomExclusion={handleAddCustomExclusion}
                onToggleExclusion={handleToggleExclusion}
                suggestedKeywords={draftRequirement?.expanded_search_terms ?? draftRequirement?.keywords}
                selectedKeywords={selectedKeywords}
                onChangeKeywords={handleKeywordsChange}
                lastSql={lastSql}
                onClearSession={handleResetSession}
                libraryCategory={libraryCategory}
                onChangeLibraryCategory={handleLibraryCategoryChange}
                availableCategories={availableCategories}
                loadingCategory={loadingCategory}
              />
            </div>
          </div>
        </div>
      )}

      <Toast message={toastMessage} />
    </div>
  );
}
