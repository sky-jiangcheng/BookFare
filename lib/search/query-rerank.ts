interface CatalogRerankBook {
  title?: unknown;
  author?: unknown;
  publisher?: unknown;
  category?: unknown;
  description?: unknown;
  relevance_score?: unknown;
  clc_code?: unknown;
  age_min?: unknown;
  age_max?: unknown;
  /** ADR-0003: normalized ts_rank_cd score ([0, 1]) from the search_tsv column. */
  fts_score?: unknown;
  // Used to key into feedback stats. Raw DB rows expose `id`; normalized Book
  // exposes `book_id`. Either may be present depending on the caller.
  book_id?: unknown;
  id?: unknown;
}

interface ScoredBook<T extends CatalogRerankBook> {
  book: T;
  score: number;
  index: number;
}

// Module-level compiled regex patterns for reuse in scoring loops
const HEALTH_PATTERN = /健康|养生|科普|医疗|免疫力|长辈|老人|中老年/;
const SCIENCE_PATTERN = /科普|科学|知识/;
const XIANGQI_PATTERN = /象棋/;
const WEIQI_PATTERN = /围棋/;
const GUOJIXIANGQI_PATTERN = /国际象棋/;
const WUZIQI_PATTERN = /五子棋/;
const HISTORY_PATTERN = /历史|传记|人物|鲁迅/;
const LUXUN_PATTERN = /鲁迅/;

const CATEGORY_ALIASES: Record<string, string[]> = {
  健康: ['健康', '养生', '医疗', '免疫力', '中老年', '老人', '长辈', '保健'],
  科普: ['科普', '科学', '知识', '百科'],
  历史: ['历史', '党史', '地方史', '人物传记', '地方文化', '革命', '传记'],
  计算机: ['计算机', '编程', '算法', '人工智能', '软件', '开发', 'python', 'java', 'javascript'],
  教育: ['教育', '教学', '教材', '教辅'],
  文学: ['文学', '小说', '散文', '诗歌'],
  旅游: ['旅游', '旅行', '城市', '地理'],
  心理学: ['心理', '情绪', '心态', '心理学'],
  政治: ['政治', '法律', '社会', '行政法'],
  经济: ['经济', '管理', '商业', '运营', '营销', '新媒体', '电商'],
  法律: ['法律', '法学', '法规', '法务', '合同法', '民法典', '刑法', '诉讼'],
  公共管理: ['公共管理', '行政管理', '公共政策', '政府', '行政'],
  办公室: ['办公室', '职场', '办公', '公文', '秘书', '职场礼仪', '职场技能'],
  哲学: ['哲学', '思想', '伦理'],
  艺术: ['艺术', '美术', '设计', '摄影', '音乐'],
  少儿: ['少儿', '儿童', '绘本', '亲子'],
  金融: ['金融', '投资', '理财', '财务'],
  成长: ['职场', '沟通', '演讲', '写作', '思维', '成长', '自我提升', '领导力'],
  棋牌: ['围棋', '象棋', '国际象棋', '五子棋'],
};

const GENERIC_STOPWORDS = new Set<string>([
  '推荐',
  '书',
  '书籍',
  '书单',
  '适合',
  '相关',
  '一些',
  '一个',
  '一本',
  '给我',
  '来',
  '看看',
  '可以',
  '想要',
  '希望',
  '关于',
  '比较',
  '家里',
  '家人',
  '最好',
  '请',
  '帮我',
  '有哪些',
  '哪些',
]);

const SEARCH_INTENT_RULES: Array<{ terms: string[]; triggers: string[] }> = [
  { terms: ['人工智能', 'AI', '机器学习', '深度学习', '智能'], triggers: ['人工智能', 'AI', '机器学习', '深度学习'] },
  { terms: ['健康', '养生', '医疗', '免疫力', '中老年', '老人', '长辈', '保健', '科普'], triggers: ['健康', '养生', '医疗', '免疫力', '中老年', '老人', '长辈', '保健'] },
  { terms: ['科普', '科学', '知识', '百科'], triggers: ['科普', '科学', '知识', '百科'] },
  { terms: ['历史', '传记', '人物', '鲁迅'], triggers: ['历史', '传记', '人物', '鲁迅'] },
  { terms: ['旅游', '旅行', '城市', '文化', '人文', '地理'], triggers: ['旅游', '旅行', '景点', '城市', '人文', '文化'] },
  { terms: ['心理', '情绪', '心态', '心理学'], triggers: ['心理', '情绪', '心态', '心理学'] },
  { terms: ['职场', '沟通', '演讲', '写作', '思维'], triggers: ['职场', '沟通', '演讲', '写作', '思维'] },
  { terms: ['运营', '营销', '管理', '新媒体', '电商', '商业'], triggers: ['运营', '营销', '新媒体', '电商'] },
  { terms: ['儿童', '少儿', '绘本', '亲子'], triggers: ['儿童', '少儿', '绘本', '亲子'] },
  { terms: ['象棋', '残局', '布局', '开局', '中局', '实战'], triggers: ['象棋'] },
  { terms: ['围棋', '定式', '死活', '布局', '实战'], triggers: ['围棋'] },
  { terms: ['国际象棋', '开局', '中局', '残局', '实战'], triggers: ['国际象棋'] },
  { terms: ['五子棋', '布局', '实战', '开局'], triggers: ['五子棋'] },
  { terms: ['法律', '法学', '行政法', '行政诉讼法', '宪法', '民法', '刑法'], triggers: ['法律', '法学', '行政法', '行政诉讼法', '行政', '诉讼法', '宪法', '民法', '刑法'] },
  // 公共管理/政治学
  { terms: ['公共管理', '行政管理', '政治学', '政治', '公共', '行政'], triggers: ['公共管理', '公共行政', '政治学', '行政管理', '公共', '行政'] },
  // 办公室实务/职业发展
  { terms: ['办公室', '实务', '办公', '职业', '职场', '新人', '工作'], triggers: ['办公室', '实务', '办公', '职业', '职场', '新人', '工作'] },
  // 金融/投资/理财
  { terms: ['金融', '投资', '理财', '财务', '经济'], triggers: ['金融', '投资', '理财', '财务', '经济'] },
];

function normalizeText(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }

  return String(value).toLowerCase().replace(/\s+/g, ' ').trim();
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function collectIntentTerms(normalizedQuery: string): string[] {
  const terms: string[] = [];

  for (const rule of SEARCH_INTENT_RULES) {
    if (rule.triggers.some((trigger) => normalizedQuery.includes(trigger.toLowerCase()))) {
      for (const term of rule.terms) {
        terms.push(term.toLowerCase());
      }
    }
  }

  return unique(terms);
}

function extractTerms(query: unknown): string[] {
  const normalized = normalizeText(query);
  if (!normalized) {
    return [];
  }

  const rawTerms = normalized.match(/[\p{Script=Han}]{2,}|[\p{L}\p{N}]{2,}/gu) ?? [];
  const terms: string[] = [];

  for (const term of rawTerms) {
    const trimmed = term.trim();
    if (!trimmed || GENERIC_STOPWORDS.has(trimmed)) {
      continue;
    }

    if (/[\p{Script=Han}]/u.test(trimmed)) {
      if (trimmed.length <= 4) {
        terms.push(trimmed);
      }
      for (let i = 0; i <= trimmed.length - 2; i++) {
        const bigram = trimmed.slice(i, i + 2);
        if (!GENERIC_STOPWORDS.has(bigram)) {
          terms.push(bigram);
        }
      }
      for (let i = 0; i <= trimmed.length - 3; i++) {
        const trigram = trimmed.slice(i, i + 3);
        if (!GENERIC_STOPWORDS.has(trigram)) {
          terms.push(trigram);
        }
      }
    } else {
      terms.push(trimmed);
    }
  }

  terms.push(...collectIntentTerms(normalized));

  return unique(terms);
}

function buildCatalogSearchTerms(query: unknown): string[] {
  const normalized = normalizeText(query);
  if (!normalized) {
    return [];
  }

  const terms = collectIntentTerms(normalized);
  if (terms.length > 0) {
    return terms;
  }

  const fallbackTerms = normalized.match(/[\p{Script=Han}]{2,}|[\p{L}\p{N}]{2,}/gu) ?? [];
  const extracted: string[] = [];

  for (const term of fallbackTerms) {
    const trimmed = term.trim();
    if (!trimmed || GENERIC_STOPWORDS.has(trimmed)) {
      continue;
    }

    if (/[\p{Script=Han}]/u.test(trimmed)) {
      if (trimmed.length <= 4) {
        extracted.push(trimmed);
      }
      for (let i = 0; i <= trimmed.length - 2; i++) {
        const bigram = trimmed.slice(i, i + 2);
        if (!GENERIC_STOPWORDS.has(bigram)) {
          extracted.push(bigram);
        }
      }
      for (let i = 0; i <= trimmed.length - 3; i++) {
        const trigram = trimmed.slice(i, i + 3);
        if (!GENERIC_STOPWORDS.has(trigram)) {
          extracted.push(trigram);
        }
      }
    } else {
      extracted.push(trimmed);
    }
  }

  return unique(extracted).slice(0, 12);
}

function matchCount(haystack: string, terms: string[]): number {
  let count = 0;
  for (const term of terms) {
    if (term && haystack.includes(term)) {
      count += 1;
    }
  }
  return count;
}

function containsAny(haystack: string, terms: string[]): boolean {
  return terms.some((term) => term && haystack.includes(term));
}

function matchCategories(book: CatalogRerankBook, normalizedQuery: string): string[] {
  const category = normalizeText(book.category);
  const title = normalizeText(book.title);
  const queryCategoryHits: string[] = [];

  for (const [label, aliases] of Object.entries(CATEGORY_ALIASES)) {
    const matched = aliases.some((alias) => normalizedQuery.includes(alias.toLowerCase()));
    if (matched && (label.toLowerCase() === category || aliases.some((alias) => category.includes(alias.toLowerCase())))) {
      queryCategoryHits.push(label);
      continue;
    }

    if (matched && aliases.some((alias) => title.includes(alias.toLowerCase()))) {
      queryCategoryHits.push(label);
    }
  }

  return unique(queryCategoryHits);
}

interface RerankOptions {
  query?: unknown;
  requirement?: import('@/lib/types/rag').RequirementAnalysis;
  feedbackStats?: Record<string, import('@/lib/types/rag').FeedbackStats>;
}

function computeBookScore(
  book: CatalogRerankBook,
  index: number,
  options: RerankOptions,
): { score: number; index: number } {
  const { query, requirement, feedbackStats } = options;
  const normalizedQuery = normalizeText(requirement?.original_query || query);
  const queryTerms = requirement?.keywords?.length
    ? unique(requirement.keywords.map((k: string) => k.toLowerCase()))
    : extractTerms(requirement?.original_query || query);
  const title = normalizeText(book.title);
  const author = normalizeText(book.author);
  const publisher = normalizeText(book.publisher);
  const category = normalizeText(book.category);
  const description = normalizeText(book.description);
  const haystack = `${title} ${author} ${publisher} ${category} ${description}`.trim();
  const relevance = Number(book.relevance_score ?? 0);

  if (!normalizedQuery && queryTerms.length === 0) {
    return {
      score: relevance,
      index,
    };
  }

  let score = Math.log1p(Math.max(0, relevance)) * 0.35;

  const titleHits = matchCount(title, queryTerms);
  const authorHits = matchCount(author, queryTerms);
  const publisherHits = matchCount(publisher, queryTerms);
  const categoryHits = matchCount(category, queryTerms);
  const descriptionHits = matchCount(description, queryTerms);
  
  const categoriesToMatch = requirement?.categories?.length
    ? requirement.categories
    : matchCategories(book, normalizedQuery);

  const categoryMatch = categoriesToMatch.some((cat: string) =>
    category.includes(cat.toLowerCase()) || title.includes(cat.toLowerCase())
  );

  score += titleHits * 3.5;
  score += categoryHits * 2.6;
  score += authorHits * 1.4;
  score += publisherHits * 0.8;
  score += descriptionHits * 0.6;

  if (categoryMatch) {
    score += 4.5;
  }

  if (titleHits > 0 && categoryHits > 0) {
    score += 1.25;
  }

  if (titleHits > 0 && HEALTH_PATTERN.test(normalizedQuery)) {
    score += 0.9;
  }

  const lexicalOverlap = titleHits + authorHits + publisherHits + categoryHits + descriptionHits;
  if (lexicalOverlap === 0) {
    score -= 2.75;
  }

  // ADR-0003: PG full-text ranking signal (ts_rank_cd over search_tsv,
  // normalized to [0, 1] across the candidate pool). A full-strength hit
  // weighs in above a single title match (3.5) on its own scale.
  const ftsScore = Number(book.fts_score ?? 0);
  if (Number.isFinite(ftsScore) && ftsScore > 0) {
    score += 4.0 * Math.min(1, ftsScore);
  }

  const excludedKeywords = requirement?.constraints?.exclude_keywords || [];
  const hasExclusions = excludedKeywords.some((keyword: string) =>
    haystack.includes(keyword.toLowerCase())
  );
  if (hasExclusions) {
    score -= 10;
  }

  if (HEALTH_PATTERN.test(normalizedQuery) && HEALTH_PATTERN.test(haystack)) {
    score += 2.2;
  }

  if (SCIENCE_PATTERN.test(normalizedQuery) && SCIENCE_PATTERN.test(haystack)) {
    score += 1.8;
  }

  const hasXiangqiTopic = XIANGQI_PATTERN.test(normalizedQuery);
  const hasWeiqiTopic = WEIQI_PATTERN.test(normalizedQuery);
  const hasGuojiXiangqiTopic = GUOJIXIANGQI_PATTERN.test(normalizedQuery);
  const hasWuziqiTopic = WUZIQI_PATTERN.test(normalizedQuery);
  const hasHistoryBioTopic = HISTORY_PATTERN.test(normalizedQuery);
  const hasLuXunTopic = LUXUN_PATTERN.test(normalizedQuery);

  if (hasXiangqiTopic) {
    if (containsAny(haystack, ['象棋'])) {
      score += 4.5;
    }
    if (containsAny(haystack, ['围棋', '国际象棋', '五子棋'])) {
      score -= 4.5;
    }
  }

  if (hasWeiqiTopic) {
    if (containsAny(haystack, ['围棋'])) {
      score += 4.5;
    }
    if (containsAny(haystack, ['象棋', '国际象棋', '五子棋'])) {
      score -= 4.5;
    }
  }

  if (hasGuojiXiangqiTopic) {
    if (containsAny(haystack, ['国际象棋'])) {
      score += 4.5;
    }
    if (containsAny(haystack, ['象棋', '围棋', '五子棋'])) {
      score -= 4.5;
    }
  }

  if (hasWuziqiTopic) {
    if (containsAny(haystack, ['五子棋'])) {
      score += 4.5;
    }
    if (containsAny(haystack, ['象棋', '围棋', '国际象棋'])) {
      score -= 4.5;
    }
  }

  const clcCode = normalizeText(book.clc_code);
  const ageMin = book.age_min !== null && book.age_min !== undefined ? Number(book.age_min) : null;
  const ageMax = book.age_max !== null && book.age_max !== undefined ? Number(book.age_max) : null;

  if (hasHistoryBioTopic) {
    if (clcCode.startsWith('k')) {
      score += 2.8;
    } else if (containsAny(haystack, ['传记', '人物', '鲁迅'])) {
      score += 2.8;
    }
    if (clcCode.startsWith('i24')) {
      score -= 2.6;
    } else if (containsAny(haystack, ['小说'])) {
      score -= 2.6;
    }
  }

  // Boost science books for science-popularization queries
  if (SCIENCE_PATTERN.test(normalizedQuery) && (clcCode.startsWith('n') || clcCode.startsWith('o') || clcCode.startsWith('p') || clcCode.startsWith('q') || clcCode.startsWith('r') || clcCode.startsWith('s') || clcCode.startsWith('t'))) {
    score += 1.8;
  }

  // Optimize targeting alignment based on age range
  if (requirement?.inferred_library_type === '小学') {
    if (ageMin !== null && ageMax !== null) {
      if (ageMin <= 12 && ageMax >= 6) {
        score += 3.0; // Age-appropriate boost
      } else {
        score -= 3.0; // Age-inappropriate penalty
      }
    }
  } else if (requirement?.inferred_library_type === '初高中') {
    if (ageMin !== null && ageMax !== null) {
      if (ageMin <= 18 && ageMax >= 12) {
        score += 3.0; // Age-appropriate boost
      } else {
        score -= 3.0; // Age-inappropriate penalty
      }
    }
  }

  if (hasLuXunTopic) {
    if (containsAny(haystack, ['鲁迅'])) {
      score += 20;
    } else {
      score -= 4.5;
    }
  }

  const rawId = book.book_id ?? book.id;
  const bookId = rawId == null ? '' : String(rawId);
  if (feedbackStats && bookId && feedbackStats[bookId]) {
    const stats = feedbackStats[bookId];
    const pos = Number(stats.positiveCount || 0);
    const neg = Number(stats.negativeCount || 0);
    const boost = Math.log1p(pos) * 1.5 - neg * 0.8;
    score += boost;
  }

  return {
    score,
    index,
  };
}

async function rerankCatalogBooks<T extends CatalogRerankBook>(
  books: T[],
  query: unknown,
  requirement?: import('@/lib/types/rag').RequirementAnalysis,
  feedbackStats?: Record<string, import('@/lib/types/rag').FeedbackStats>,
): Promise<Array<T & { relevance_score: number }>> {
  if (!Array.isArray(books) || books.length === 0) {
    return [];
  }

  const scored: Array<ScoredBook<T>> = books.map((book, index) => ({
    book,
    ...computeBookScore(book, index, { query, requirement, feedbackStats }),
  }));

  const sorted = [...scored].sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return a.index - b.index;
  });

  return sorted.map(({ book, score }) => ({
    ...book,
    relevance_score: score,
  })) as Array<T & { relevance_score: number }>;
}

export {
  CATEGORY_ALIASES,
  buildCatalogSearchTerms,
  rerankCatalogBooks,
};
