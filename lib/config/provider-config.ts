export const OPENAI_COMPATIBLE = 'openai-compatible' as const;
export type LLMProviderType = typeof OPENAI_COMPATIBLE;

export interface LLMProviderConfig {
  type: LLMProviderType;
  apiKey: string;
  model: string;
  baseUrl?: string;
}

export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';

export const DEFAULT_PROVIDER_CONFIG: LLMProviderConfig = {
  type: 'openai-compatible',
  apiKey: '',
  model: 'gemini-2.0-flash',
  baseUrl: GEMINI_BASE_URL,
};

const STORAGE_KEY = 'rag-llm-provider';

export function loadProviderConfig(): LLMProviderConfig {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (parsed.type === 'google') {
        parsed.type = 'openai-compatible';
        if (!parsed.baseUrl) {
          parsed.baseUrl = GEMINI_BASE_URL;
        }
      }
      return parsed as LLMProviderConfig;
    }
  } catch (error) {
    // Corrupt/missing persisted config is non-fatal — fall back to defaults —
    // but log so a user reporting "my settings were lost" is debuggable.
    console.warn('[provider-config] Failed to load persisted LLM provider config, using defaults:', error);
  }
  return { ...DEFAULT_PROVIDER_CONFIG };
}

export function saveProviderConfig(config: LLMProviderConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}
