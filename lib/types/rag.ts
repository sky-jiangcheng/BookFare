export interface Book {
  book_id: string;
  title: string;
  author: string;
  publisher: string;
  publication_year?: number;
  price: number;
  stock: number;
  category: string;
  description: string;
  cover_url?: string;
  relevance_score: number;
  popularity_score?: number;
  is_abnormal_id?: boolean;
  clc_code?: string;
  age_min?: number;
  age_max?: number;
  /** ADR-0003: ts_rank_cd score over search_tsv, normalized to [0, 1] per pool. */
  fts_score?: number;
}

export interface RequirementAnalysis {
  analysis_strategy?: 'llm' | 'local-fallback';
  original_query: string;
  categories: string[];
  keywords: string[];
  expanded_search_terms: string[];
  constraints: {
    budget?: number;
    target_count?: number;
    author?: string;
    price_min?: number;
    price_max?: number;
    publication_year_min?: number;
    publication_year_max?: number;
    exclude_keywords?: string[];
  };
  preferences: string[];
  needs_clarification: boolean;
  clarification_questions: string[];
  inferred_library_type?: '公共馆' | '成人目录' | '初高中' | '小学' | '大学' | 'none';
}

export interface RetrievalResult {
  books: Book[];
  sources: ('keyword' | 'popular' | 'popular-fallback')[];
  total_candidates: number;
  sql?: string;
}

export interface RecommendedBook extends Book {
  explanation: string;
  /** Optional provenance label (e.g. 'keyword' / 'popular') added at retrieval time. */
  source?: string;
}

export interface RecommendationResult {
  books: RecommendedBook[];
  total_price: number;
  quality_score: number;
  confidence: number;
  category_distribution: Record<string, number>;
}

export interface AgentProgress {
  type: 'phase_start' | 'phase_complete' | 'complete' | 'error';
  phase?: 'requirement_analysis' | 'retrieval' | 'generation';
  content: string;
  data?: Record<string, unknown>;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface CatalogSearchFilters {
  categories?: string[];
  author?: string;
  price_min?: number;
  price_max?: number;
  publication_year_min?: number;
  publication_year_max?: number;
  query?: string;
  search_terms?: string[];
  limit?: number;
  page?: number;
  requirement?: RequirementAnalysis;
  library_category?: string;
}

export interface UserInfo {
  userId: string;
  preferences: {
    favoriteCategories?: string[];
    priceRange?: { min: number; max: number };
  };
}

/**
 * User feedback types
 */
export interface UserFeedback {
  id: string;
  sessionId: string;
  query: string;
  bookId: string;
  feedbackType: 'thumbs_up' | 'thumbs_down' | 'not_relevant' | 'click';
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface FeedbackStats {
  bookId: string;
  positiveCount: number;
  negativeCount: number;
  averageScore: number;
  totalFeedback: number;
}

/**
 * Conversation memory for multi-turn dialogue
 */
export interface ConversationTurn {
  id: string;
  sessionId: string;
  timestamp: number;
  role: 'user' | 'assistant';
  content: string;
  requirement?: RequirementAnalysis;
  recommendations?: RecommendedBook[];
}

export interface ConversationSession {
  id: string;
  createdAt: number;
  updatedAt: number;
  turns: ConversationTurn[];
  metadata: {
    userId?: string;
    startTime: number;
    turnCount: number;
  };
}
