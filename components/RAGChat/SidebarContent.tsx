'use client';

import { Sparkles, Plus, MessageSquare, Trash2, Bookmark } from 'lucide-react';
import type { SessionItem } from '@/components/rag-chat-utils';
import type { RequirementTemplate } from '@/components/query-preparation';
import { LLMSettingsDialog } from '@/components/RAGChat/LLMSettingsDialog';
import type { LLMProviderConfig } from '@/lib/config/provider-config';

interface SidebarContentProps {
  sessions: SessionItem[];
  activeSessionId: string | null;
  templates: RequirementTemplate[];
  llmProvider: LLMProviderConfig;
  onCreateSession: () => void;
  onSwitchSession: (id: string) => void;
  onDeleteSession: (id: string, e: React.MouseEvent) => void;
  onSaveSessionAsTemplate: (session: SessionItem) => void;
  onApplyTemplate: (template: RequirementTemplate) => void;
  onProviderSave: (config: LLMProviderConfig) => void;
  onClose?: () => void;
}

/**
 * Left sidebar: session history + requirement templates + LLM settings.
 * Rendered both in the desktop <aside> and the mobile drawer, so it stays a
 * pure presentational component driven entirely by props.
 */
export function SidebarContent({
  sessions,
  activeSessionId,
  templates,
  llmProvider,
  onCreateSession,
  onSwitchSession,
  onDeleteSession,
  onSaveSessionAsTemplate,
  onApplyTemplate,
  onProviderSave,
  onClose,
}: SidebarContentProps) {
  return (
    <div className="flex flex-col justify-between h-full">
      <div className="flex flex-col h-full min-h-0">
        <div className="flex items-center gap-2 px-1 py-3 mb-4 select-none">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-blue-600 to-indigo-600 flex items-center justify-center text-white border border-white/10 shadow-md">
            <Sparkles className="w-4 h-4" />
          </div>
          <div>
            <h1 className="text-sm font-bold text-slate-200 tracking-tight leading-none">BookStore RAG</h1>
            <span className="text-[9px] text-slate-500 font-mono">v1.2</span>
          </div>
        </div>

        <button
          type="button"
          onClick={() => {
            onCreateSession();
            onClose?.();
          }}
          className="flex items-center justify-center gap-2 w-full py-2.5 px-4 mb-4 rounded-xl border border-white/10 hover:border-blue-500/40 hover:bg-slate-900/60 text-slate-200 hover:text-white transition-all text-xs font-bold shadow-md shadow-black/10 active:scale-95"
        >
          <Plus className="w-4 h-4 text-blue-400" />
          <span>新建推荐会话</span>
        </button>

        <div className="text-[10px] text-slate-500 font-bold uppercase tracking-wider mb-2 px-1">
          会话历史
        </div>

        <div className="flex-1 overflow-y-auto space-y-1.5 pr-1 min-h-0">
          {sessions.map((sess) => {
            const isActive = sess.id === activeSessionId;
            return (
              <div
                key={sess.id}
                onClick={() => {
                  onSwitchSession(sess.id);
                  onClose?.();
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  onSaveSessionAsTemplate(sess);
                }}
                title="右键保存为需求模板并修改模板名称"
                className={`group flex items-center justify-between p-3 rounded-xl cursor-pointer transition-all duration-300 border text-xs font-semibold select-none ${
                  isActive
                    ? 'bg-blue-600/15 text-blue-400 border-blue-500/25 shadow-sm shadow-blue-500/5'
                    : 'bg-transparent text-slate-400 border-transparent hover:bg-slate-900/45 hover:text-slate-200'
                }`}
              >
                <div className="flex items-center gap-2 truncate flex-1 min-w-0 pr-1">
                  <MessageSquare className={`w-3.5 h-3.5 shrink-0 ${isActive ? 'text-blue-400' : 'text-slate-500'}`} />
                  <span className="truncate">{sess.title || '新推荐会话'}</span>
                </div>

                <button
                  type="button"
                  onClick={(e) => onDeleteSession(sess.id, e)}
                  className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-slate-800 text-slate-500 hover:text-rose-400 transition-all active:scale-90"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            );
          })}
        </div>

        <div className="mt-5 border-t border-white/5 pt-4">
          <div className="mb-2 flex items-center justify-between px-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">
            <span>需求模板</span>
            <Bookmark className="h-3.5 w-3.5" />
          </div>
          <div className="space-y-1.5">
            {templates.length === 0 ? (
              <p className="px-1 text-[10px] leading-4 text-slate-600">右键会话可保存模板</p>
            ) : templates.map((template) => (
              <button
                key={template.id}
                type="button"
                onClick={() => {
                  onApplyTemplate(template);
                  onClose?.();
                }}
                className="w-full rounded-md border border-transparent px-2.5 py-2 text-left hover:border-slate-700 hover:bg-slate-900/60"
              >
                <span className="block truncate text-[11px] font-semibold text-slate-300">{template.name}</span>
                <span className="mt-1 block text-[9px] text-slate-600">精确命中后跳过 LLM</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="border-t border-white/5 pt-4 space-y-2 select-none shrink-0">
        <LLMSettingsDialog config={llmProvider} onSave={onProviderSave} />
        <div className="text-[10px] text-slate-600 text-center font-mono">
          <div>{llmProvider.model || 'LLM'} RAG Engine</div>
          <div className="mt-0.5 opacity-60">© 2026 Antigravity</div>
        </div>
      </div>
    </div>
  );
}
