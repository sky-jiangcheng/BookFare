# ADR-0003：全文排序采用 PG 原生 tsvector（L2）

- 日期：2026-10-31
- 状态：🔵 Proposed（待确认，依赖 ADR-0002 落地后评估）

## 背景

关键词召回后缺少词频/IDF 感知的文本相关性初排，目前依赖 `lib/search/query-rerank.ts` 的手工权重（标题 3.5 / 分类 2.6 / 作者 1.4 …）。手工权重对长尾查询泛化差，且每新增一个垂直品类就要加一段专题规则（现状已有健康养生/科普/棋牌/鲁迅等 6+ 个专题分支）。

已核实：Neon **不提供** pg_search（BM25 扩展，已下线新项目），但 PG 原生全文检索（tsvector/tsquery + GIN）与 RUM 索引可用。

## 决策

用 PG 原生 `tsvector` 全文检索作为召回结果的**初排信号**，不引入外部 BM25：

1. `books` 表新增 `search_tsv tsvector` 生成列（`to_tsvector('simple', title || author || category || description)`），GIN 索引
2. `ts_rank_cd` 得分作为 `S_total` 中一个新的加权子项（替代部分专题手工规则）
3. 中文分词以 `simple` 配置 + 现有分词逻辑为准（PG 自带中文解析器效果有限，不引入 zhparser 以避免扩展依赖）

## 备选方案（被否决）

| 方案 | 否决理由 |
|---|---|
| pg_search（ParadeDB） | Neon 已下线，需迁移出 Neon，违反"单一 Postgres"约束 |
| 外部搜索服务（Meilisearch/Typesense） | 新增运维面与数据同步链路，当前数据量下收益不成比例 |
| zhparser/pg_jieba 中文分词扩展 | Neon 不支持自定义扩展 |

## 后果

- 正面：零成本获得词频相关性信号；可逐步退役 `query-rerank.ts` 中的专题硬编码分支
- 负面：`simple` 分词对中文是逐字切分，召回精度弱于真分词，需靠 trgm + 语义通道补足；tsvector 生成列增加约 10-20% 存储与写放大
- 风险：若中文逐字切分实测收益为负，则放弃本 ADR，保持手工重排（可接受，这是低成本实验）
