# ADR-0001：项目名与品牌名分离

- 日期：2026-10-31
- 状态：✅ Accepted（已采纳并实施）

## 背景

项目原名 `bookstore-agentic-rag`，冗长且无法对外传播。需要一个对内的技术项目名（用于 package.json、仓库名、服务标识）和一个对外的品牌名（用于 UI 标题、文档、推广）。原候选 `book-fare` 中 fare 与 fair 同音，存在歧义。

## 决策

| 层 | 名称 | 用途 |
|---|---|---|
| 项目名 | `book-ferry` | package.json name、仓库名、`/api/health` service 字段、Vercel 项目名 |
| 品牌名 | `BookFerry`（中文：书渡） | 页面 title、README 标题、对外文案 |

命名含义：ferry（渡船）承载"摆渡人把读者渡向书海"的产品隐喻，与推荐系统定位契合，且规避了 fare/fair 同音问题。

## 实施记录（2026-10-31）

- `package.json` name → `book-ferry`
- `app/api/health/route.ts` service → `book-ferry`
- `app/layout.tsx` metadata.title → `BookFerry 书渡 · 智能图书推荐系统`
- `README.md` 标题 → `# BookFerry 书渡（项目名：book-ferry）`，并修复重排公式章节指向本地绝对路径的失效链接
- `package-lock.json` 已同步重新生成
- GitHub 远程仓库已由 `sky-jiangcheng/BookFare` 改名为 `sky-jiangcheng/book-ferry`（2026-11-02，本地 remote URL 已同步更新），旧地址由 GitHub 自动重定向
- `issue-vercel-unreachable.md` 中旧部署域名 `bookstore-agentic-rag.vercel.app` 为历史记录，保留不改；Vercel 项目重命名后旧域名将失效，需配置 redirect 或更新该记录

## 后果

- 仓库根目录名如仍为旧名，clone 时需以 `book-ferry` 为准（Git 重命名仓库在远程平台上操作）
- Vercel 项目名独立于 package name，需在 Vercel 控制台同步改名
