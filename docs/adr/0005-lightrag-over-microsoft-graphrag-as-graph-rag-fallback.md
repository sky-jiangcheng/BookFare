# ADR-0005：Graph RAG 框架备选定为 LightRAG，拒绝 Microsoft GraphRAG（L4，暂缓）

- 日期：2026-10-31
- 状态：⏸ Deferred（暂缓，作为 ADR-0004 能力不足时的升级预案；观察期 2026-11 至 2027-02）

## 背景

用户提出引入 LightRAG 或 Microsoft GraphRAG。调研结论（2026-10-31，含 LightRAG 论文 arXiv:2410.05779 与社区基准交叉验证）：

| 维度 | LightRAG | Microsoft GraphRAG |
|---|---|---|
| 查询开销 | 单次 API 调用、<100 tokens 生成检索词 | 全局搜索数百次调用、~610k tokens/问题 |
| 索引成本 | 比 GraphRAG 快 3-5 倍、省 50-70%，质量相当 | 约为向量 RAG 的 100 倍 |
| 增量更新 | 图增量合并，无需全量重建 | 新版支持 incremental，成本仍高 |
| 查询模式 | 双层检索（实体词+主题词），匹配图书推荐场景 | 语料级主题理解，与场景错位 |
| 存储后端 | pgvector + PGTableGraphStorage（1.5.6+ 纯表，无需扩展）；或 Apache AGE | Parquet/LanceDB，无 Postgres 后端 |
| 运行时 | Python，官方 Docker REST 服务 | Python CLI/批处理管线 |

## 决策

1. **不采用 Microsoft GraphRAG**：索引成本高两个数量级、查询模式与图书推荐错位、无 Postgres 后端、无法运行在 Vercel serverless
2. **LightRAG 列为 L4 预案，暂不实施**：仅当 ADR-0003/0004 落地后仍无法覆盖"简介中隐含的模糊实体关系"时启动
3. 启用时的目标架构：`lightrag-hku` 官方 Docker 服务 + `PGTableGraphStorage` + `PGVectorStorage`，与主应用**共享同一 Neon Postgres**（workspace 字段做数据隔离）；Next.js 侧新增一个轻量 client 调其 REST API，现有重排与硬约束层不变

## 触发条件（满足任一再评估）

- ADR-0004 结构化图谱上线后，用户调研中"跨领域隐含关联"类 bad case 占比 > 20%
- 图书简介质量大幅提升（长文、多主题），结构化字段不足以表达书籍间关系
- 数据量增长至 10 万+ 且品类长尾显著

## 后果

- 正面：现在零成本；预案架构已验证可落地（Neon 纯表图存储），不会被平台能力锁死
- 负面：启用时新增一个常驻 Python 服务（~512MB 内存档即可）+ 一次性 LLM 实体抽取成本（5 万本简介约 5-15M tokens，Flash 级模型约几十美元）+ 部署运维面扩大
- 决策人：技术负责人；重新评估时间：ADR-0002/0003/0004 全部落地后一个季度

## 观察期记录

- 2026-11-02：ADR-0002/0003/0004 全部落地（commits 2306eaa、2a0b3b9、2cf2cef，已推送 main），观察期正式启动，为期一个季度，至 2027-02 前后复盘。
- 度量口径：按月抽样负反馈（thumbs-down）会话，人工标注其中"跨领域隐含关联"类（即 ADR-0004 结构化图谱无法覆盖的模糊实体关系）bad case 占比；连续或累计占比 > 20% 即触发本预案重评。
- 复盘产出：更新本 ADR 状态（维持 Deferred / 升级为 Accepted 并按"决策"第 3 条架构实施）。
