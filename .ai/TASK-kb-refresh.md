# Task (BACKLOG，待用户确认数据源后开工): 政策知识库每日刷新 + Lambda 定时

> 状态：**未开工**。用户已认可功能，但数据源策略/具体主题 URL 待定（见 Open decisions）。先按默认方案设计，确认后再交 Codex。

## Goal
让 agent 每天自动刷新 H1B / CAQ 等政策知识，存进**全局 RAG 知识库**并保持最新版；`/api/chat` 能基于最新政策回答（例如「最新 H1B 抽签规则是什么」）。由 AWS Lambda + EventBridge 每天定时触发；同一套逻辑做成本地脚本便于手动跑/演示。

## Context
- 现有：`memory_documents`/`memory_chunks`(VECTOR(1024), cosine 索引)、`/api/chat` 的 `searchChunks(userId, ...)`。
- 复用 `web/lib/bedrock.ts` 的 `embed`/`chunkText`、`web/lib/db.ts` 的 `withTransaction`。

## 设计决策（已定）
- **全局知识库**：政策不属于任一用户，用固定 `SYSTEM_USER_ID`（如 `00000000-0000-0000-0000-0000000000ff`）+ `source_type='policy'` 存进现有 `memory_chunks`，复用同一向量索引。
- **保持最新版**：每个政策源一个稳定 `source_key`（如 `uscis-h1b`、`quebec-caq`）。刷新时内容变了就**删该 source_key 的旧 document（CASCADE 删 chunks）→ 写新版**，不无脑追加。
- **chat 纳入 KB**：`searchChunks` 改为检索 `user_id IN (userId, SYSTEM_USER_ID)`，返回来源标注（user memory vs policy）。
- **留痕**：每次刷新写 `agent_events('kb_refresh')`（含 source_key、changed/skipped、chunkCount）。

## Requirements
1. **Schema**：`memory_documents` 加 `source_key STRING`（可空）；SYSTEM 用户下 source_key 需能唯一定位最新版（partial unique index 或应用层删旧写新）。
2. **配置** `infra/kb-sources.json`：`[{ key, title, url, topic }]`。按选定主题填真实官方 URL（**待定，先占位标 TODO**）。
3. **`web/lib/kb.ts`**：
   - `refreshSource(source)`：fetch(url, timeout+UA) → 抽正文(去 HTML/脚本) → sha256 → 与已存版本 hash 比对；相同→skip；不同→事务内删旧 source_key document → chunk+限并发 embed → 插新 document(SYSTEM_USER_ID, source_type='policy', source_key) + chunks → agent_events('kb_refresh')。
   - `refreshAll()`：遍历 kb-sources.json，**逐源 try/catch，单源失败不影响其它**，返回 `{key, status:'updated'|'skipped'|'error', ...}[]`。
4. **`scripts/refresh-kb.ts`**：本地跑 `refreshAll()`（读 web/.env.local），打印每源结果。
5. **`agent/handler.ts`**：Lambda handler 调 `refreshAll()`；返回汇总；错误不 throw 裸奔。
6. **部署**：EventBridge 每天一次 cron → Lambda；Lambda 环境需 `DATABASE_URL` + AWS 凭证(Bedrock)。先文档化到 `infra/`（可选 SAM/CDK）。

## Constraints
- 不碰 teammate 前端文件（page/layout/components）。英文文案。pg + 原生参数化 SQL。
- 政策内容**忠实来源**，不让 LLM 编造政策；若后续选「Claude 清洗」方案，须保留并标注来源。
- 抓取必须 timeout + UA header + 失败降级；单源挂掉不能拖垮整个 job。
- 保持最新版：同 source_key 只留一份最新，旧版删除。
- 复用现有 lib，别重复造 embed/chunk。

## Open decisions（用户后续拍板，开工前必确认）
- **数据源策略**：默认「抓官方 URL 原文 fetch+extract」；备选「URL + Claude 清洗成要点」/「每日 web 搜索」。
- **覆盖主题 + 真实源 URL**：H1B(USCIS)、CAQ/魁省移民、加拿大学签/PGWP、通用签证提醒——需确认要哪些 + 对应官方 URL。

## Acceptance Criteria（开工后）
- `npx tsx scripts/refresh-kb.ts` 跑通：每源输出 updated/skipped/error；库里 SYSTEM 用户下出现 policy document+chunks(embedding 1024)。
- 二次运行同内容源 → status=skipped（hash 未变，不重复 embed）。
- 改动某源内容再跑 → 旧版被删、新版写入，chunk 数以新版为准（无残留旧 chunk）。
- `/api/chat` 问政策类问题能召回 policy chunk 并作答，sources 标出 policy 来源。
- Lambda handler 本地 mock 调用 `refreshAll` 成功。

## Review Focus
- 版本替换的事务边界（删旧+写新原子，别出现中间态半份）。
- 单源失败隔离是否真生效。
- SYSTEM_USER_ID 与真实用户数据隔离/联合检索是否正确。
- 抓取的正文抽取质量（去导航/脚本噪声）。
- 保持最新：确认无旧 chunk 残留污染检索。

## 备注
- 原计划 Lambda 还有一路「每日扫 deadline 发提醒」——那是**另一个任务**，不在本单范围。
