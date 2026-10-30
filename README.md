# BookFerry 书渡（项目名：book-ferry）

面向 Vercel 部署的图书智能推荐系统。系统使用 Gemini 解析自然语言需求，以 Postgres 关键词召回和本地相关度排序替代向量数据库，并支持多轮对话和 Excel 书单导出。

## 推荐流程

1. Gemini 与本地规则提取分类、关键词、扩展词和约束。
2. Postgres 使用同义词 `OR` 召回候选书。
3. 标题、分类、作者、简介和热度参与本地相关度排序。
4. Gemini 从候选中生成推荐理由；失败时自动使用规则推荐。
5. 最终执行排除词、推荐数量和总预算硬约束。

Redis 仅用于可选的会话记忆、反馈和分布式限流。未配置 Redis 时，首轮推荐仍可无状态运行。

## 技术栈

- Next.js 15
- React 19
- Vercel AI SDK
- Google Gemini
- Neon / Vercel Postgres
- 可选 Upstash Redis
- exceljs

## 本地运行

```bash
npm install
npm run dev
```

验证：

```bash
npm run test:unit
npm run typecheck
npm run build
```

## 环境变量

必需：

```dotenv
GOOGLE_API_KEY=
GOOGLE_MODEL=gemini-2.0-flash
DATABASE_URL=
```

可选：

```dotenv
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
NEXT_PUBLIC_APP_URL=http://localhost:3000
ALLOWED_ORIGINS=
```

## 数据库

初始化：

```bash
node scripts/vercel/init-db.mjs
```

数据库脚本会尝试启用 `pg_trgm` 并创建文本搜索索引。如果当前数据库不允许安装该扩展，普通 `ILIKE` 关键词检索仍可工作，只是大数据量下查询会更慢。

## API

| 端点 | 说明 |
|---|---|
| `GET /api/health` | 数据库、Redis 和搜索模式状态 |
| `POST /api/rag/chat` | 图书推荐对话 |
| `GET/POST /api/catalog/search` | 图书目录搜索 |
| `POST /api/v1/book-list/parse` | 解析书单需求 |
| `POST /api/v1/book-list/generate` | 生成推荐书单 |
| `POST /api/v1/book-list/export-excel` | 导出 Excel |

## 图书导入

```bash
npm run import:books -- ./data/books.json
```

## 冒烟测试

```bash
npm run smoke:rag
```

指定部署地址：

```bash
RAG_BASE_URL=https://your-deployment.vercel.app npm run smoke:rag
```

## 启发式相关度重排公式

为了在不消耗大量大模型 API 资源和响应时间的情况下对召回书籍进行高精度排序，系统在 [query-rerank.ts](lib/search/query-rerank.ts) 中实现了一套相关度重排算法。

书籍的总相关度得分 $S_{\text{total}}$ 的计算公式如下：

$$S_{\text{total}} = S_{\text{init}} + S_{\text{lexical}} + S_{\text{category\_match}} + S_{\text{joint}} + S_{\text{no\_overlap}} + S_{\text{exclusion}} + S_{\text{topic}} + S_{\text{feedback}}$$

各子项的详细计算规则如下：

### 1. 基础得分 ($S_{\text{init}}$)
基于数据库中存储的静态流行度分值（Popularity Score）$S_{\text{base}}$ 做对数平滑：
$$S_{\text{init}} = 0.35 \times \ln(1 + \max(0, S_{\text{base}}))$$

### 2. 词汇命中匹配分 ($S_{\text{lexical}}$)
基于分词后的检索词集合在书籍各个字段的命中次数（Sub-string Hits）加权求和：
$$S_{\text{lexical}} = 3.5 \times H_{\text{title}} + 2.6 \times H_{\text{category}} + 1.4 \times H_{\text{author}} + 0.8 \times H_{\text{publisher}} + 0.6 \times H_{\text{description}}$$
*其中 $H_{\text{field}}$ 为查询关键词在特定字段中的命中次数。*

### 3. 主题分类匹配分 ($S_{\text{category\_match}}$)
如果书籍的分类匹配到用户查询中所表达的图书分类（或者分类别名匹配到书名）：
$$S_{\text{category\_match}} = 4.5$$

### 4. 联合匹配加成 ($S_{\text{joint}}$)
如果书名和分类**同时**命中查询关键词，给予联合检索奖励分：
$$S_{\text{joint}} = 1.25$$

### 5. 零重合惩罚 ($S_{\text{no\_overlap}}$)
如果书籍的所有文本字段与检索词的重合度为零，扣减相关度：
$$S_{\text{no\_overlap}} = -2.75$$

### 6. 排除约束惩罚 ($S_{\text{exclusion}}$)
如果书籍命中用户的硬性排除词（如“排除教材”、“不要少儿”）：
$$S_{\text{exclusion}} = -10$$

### 7. 特定领域专题微调 ($S_{\text{topic}}$)
为了在垂直品类中获得更好的体验，对特定搜索词与书籍主题重合进行增减分：
- **健康养生主题**（查询包含“长辈/中老年/养生/健康/免疫力”且书籍也含此类信息）：$+2.2$。若书名命中关键词额外 $+0.9$。
- **科普专题**：$+1.8$。
- **历史传记**：书籍包含“传记/人物” $+2.8$；若是“小说”则惩罚 $-2.6$。
- **鲁迅专题**：精准命中“鲁迅” $+20$；历史/传记查询中未含“鲁迅”的书籍 $-4.5$。
- **棋牌专题**：如搜索“象棋”且书籍为象棋 $+4.5$；若书籍混入了“围棋/五子棋/国际象棋”则惩罚 $-4.5$（同理适用于其他棋类）。

### 8. 用户反馈加权 ($S_{\text{feedback}}$)
读取 Redis 中本图书的点赞（Thumbs Up）和点踩（Thumbs Down）计数：
$$S_{\text{feedback}} = 1.5 \times \ln(1 + \text{Count}_{\text{pos}}) - 0.8 \times \text{Count}_{\text{neg}}$$
从而使高质量好评书籍在同等条件下获得更高的推荐权重。

