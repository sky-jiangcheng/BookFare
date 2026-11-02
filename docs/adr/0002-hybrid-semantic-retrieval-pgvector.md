# ADR-0002：检索升级——pgvector 语义混合召回（L1）

- 日期：2026-10-31
- 状态：✅ Accepted（已实施，commit 2306eaa）

## 背景

当前召回完全依赖 `ILIKE` 关键词匹配 + pg_trgm 索引（`lib/search/catalog-query.ts`、`scripts/vercel/init-db.mjs`），无法理解语义等价表达（如"亲子共读"vs"家庭阅读"）。项目约束：无独立向量数据库、Vercel serverless 部署、Postgres 为 Neon（= Vercel Postgres）。

已核实：Neon 在所有套餐（含免费档）支持 pgvector 0.8.x；图书目录规模数千~数万本，向量数据 + HNSW 索引约 100-300 MB，在免费/低档资源内。

## 决策

在**现有 Postgres 内**新增语义召回通道，与关键词召回并行，不做架构重构：

1. `books` 表新增 `embedding vector(768)` 列（Gemini `gemini-embedding-001`），HNSW 索引
2. 召回阶段：现有 `ILIKE`/同义词 OR 召回 ∪ 向量 ANN Top-K，两路结果合并去重
3. 现有本地启发式重排（`lib/search/query-rerank.ts`）**保留不动**，仅扩大候选池
4. embedding 生成走导入管线（`scripts/import-books.mjs`）离线补齐，查询时不生成 embedding 或仅对查询词调用一次

## 备选方案（被否决）

| 方案 | 否决理由 |
|---|---|
| 独立向量库（Pinecone/Qdrant/Upstash Vector） | 新增一项付费服务与网络跳数，serverless 冷启动更敏感；pgvector 已内生于现有 Neon |
| pg_search（ParadeDB BM25） | Neon 已于 2026-03-19 起停止对新项目提供该扩展 |
| 维持纯关键词召回 | 语义鸿沟问题持续存在，当前 synonyms OR 列表只能手工补 |

## 后果

- 正面：零新增基础设施；重排逻辑与硬约束层完全复用；查询延迟预计增加 <100ms（ANN 在万级向量上）
- 负面：导入管线需新增 embedding 生成步骤（一次性 API 成本极低）；`books` 表体积增大；需处理 embedding 维度版本迁移（预留 `scripts/migrate-embedding-dims.mjs` 模式）
- 回滚方案：向量通道加 feature flag（如 `ENABLE_SEMANTIC_RECALL`），关闭即回到纯关键词路径
