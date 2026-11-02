---
title: "向量维度不匹配：运行时维度与 pgvector 列可能脱节"
labels: ["bug", "critical"]
assignees: []
status: "resolved"
resolved_at: "2026-11-02"
---

## 描述

运行时嵌入维度来自 `EMBEDDING_DIMENSIONS` 环境变量，而 `books.embedding` 列的类型在 DDL 里是硬编码的 `vector(768)`，两者互不校验。一旦环境变量被设成 `1536`（`gemini-embedding-001` 支持的合法值），Gemini 就返回 1536 维向量，写入和检索都会失败：

```
ERROR: expected 768 dimensions, not 1536
```

检索路径上的这个异常会被 `lib/server/catalog-repository.ts` 的 try/catch 吞掉，只留一条 `console.warn`，**语义检索静默降级为纯关键词检索**——功能不报错，但召回质量断崖式下跌。

回填脚本同样有问题：`scripts/backfill-embeddings.mjs` 完全无视 `EMBEDDING_DIMENSIONS`，固定按 768 维写入，回填出来的向量和运行时请求的查询向量维度对不上。

## 原描述的更正

本 issue 最初描述的是 `lib/local-vector.ts` 的 `DENSE_DIMENSIONS = 1536` 与 `lib/postgres-vector.ts` 的 `VECTOR_DIMENSION = 768` 冲突。该描述与代码不符：

- 这三个文件（`lib/local-vector.ts`、`lib/postgres-vector.ts`、`lib/vector-service.ts`）已在 `cc7ac61`（2026-06-07，移除 Upstash Vector 依赖的重构）中删除，并有 `tests/no-vector-architecture.test.mjs` 断言它们必须不存在
- 删除前的 `lib/local-vector.ts` 中 `DENSE_DIMENSIONS` 也是 **768**，从未是 1536
- 代码中也不存在 `buildDenseVector()`、`isValidVector()` 或 `Invalid vector dimension` 这条报错文案

报错文案本身是真的，只是来源不是被描述的那几个文件。

## 影响等级

🔴 **P0** — 阻塞 — 配置一旦漂移，语义检索全线不可用且不报错

## 修复

确立**单一真相源** + **以数据库列为准**：

1. 新增 `lib/embedding-dimension.mjs` —— 维度常量、`resolveEmbeddingDimensions()`、`parseVectorColumnDimension()`、`assertEmbeddingDimension()`，运行时与 Node 脚本共用（`allowJs` 已开启）
2. `lib/config/environment.ts` 改用 `resolveEmbeddingDimensions()`，非法值直接报错而非静默回落到 768
3. `lib/ai/embeddings.ts` 在拿到响应后立即断言维度，不匹配时给出可执行的错误信息
4. `lib/server/embedding-dimension.ts` 运行时读取 `books.embedding` 列的实际维度（实例内缓存），`lib/server/catalog-repository.ts` 按该维度生成查询向量——环境变量再也无法与列脱节
5. `scripts/backfill-embeddings.mjs` 以列维度为准，`--dimensions` 与列不一致时直接报错
6. `scripts/vercel/init-db.mjs` 检测列维度与配置是否一致，不一致时明确报错并提示 `--fix-dimension`；该参数可执行迁移（重建 HNSW 索引 → 清空向量 → 改列类型 → 重建索引）

## 回归测试

`tests/embedding-dimension.test.ts` —— 覆盖维度解析、非法配置拒绝、1536/768 错配拦截，以及"任何嵌入生产/消费方都不得硬编码维度"的源码扫描守卫。

## 相关文件

- `lib/embedding-dimension.mjs` — 单一真相源
- `lib/config/environment.ts` — 运行时维度配置
- `lib/ai/embeddings.ts` — 响应维度断言
- `lib/server/embedding-dimension.ts` — 读取列维度
- `lib/server/catalog-repository.ts` — 按列维度生成查询向量
- `scripts/vercel/init-db.mjs` — 建列 / 检测 / 迁移
- `scripts/backfill-embeddings.mjs` — 按列维度回填
- `tests/embedding-dimension.test.ts` — 回归测试
