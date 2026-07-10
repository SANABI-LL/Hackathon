# Task: 后端地基 — schema + ingest 链路本地跑通

## Goal
让 `/api/ingest` 能同步跑通：收 PDF/文本 → 传 S3 → Claude 抽 deadline → Titan 生成向量 → 写 CockroachDB 4 张表 → 返回抽出的 deadline 列表。这是整个后端的地基。

## Context
- CockroachDB × AWS 黑客松，单用户 demo（hardcode APP_USER_ID）。
- 栈：Next.js 15 App Router + TS，pg 连 CockroachDB，@aws-sdk/client-bedrock-runtime + client-s3。
- Bedrock：Claude 抽取（BEDROCK_CLAUDE_MODEL_ID），Titan V2 embedding（amazon.titan-embed-text-v2:0，1024 维）。
- 架构已定：ingest 同步跑在 API route（部署 AWS Amplify，超时够）；Lambda 只做定时 agent，本任务不碰。
- 前置：web/ 需先用 `create-next-app` 建好（见 README/根目录说明）。

## Requirements
1. `infra/schema.sql`（可直接在 CRDB 跑通）：
   - users / memory_documents / memory_chunks / deadlines / agent_events / messages 六张表。
   - memory_chunks.embedding 用 `VECTOR(1024)`。
   - **删掉 messages.embedding 列**（demo 不做对话向量检索，省成本）。
   - 向量索引用 cosine：文件顶部先 `SET CLUSTER SETTING feature.vector_index.enabled = true;`，再
     `CREATE VECTOR INDEX ON memory_chunks (embedding vector_cosine_ops);`
   - deadlines 加 `UNIQUE (user_id, title, due_date)` 防重复 ingest 插重复。
   - `CREATE INDEX ON deadlines (user_id, due_date);`
2. `web/lib/db.ts`：pg Pool 连 DATABASE_URL，导出 query 帮手，连接池复用（别每请求新建）。
3. `web/lib/bedrock.ts`：
   - `extractDeadlines(text): Promise<{title,due_date,description,confidence}[]>` — 调 Claude，结构化 JSON 输出，prompt 要求只返回 JSON 数组、日期 ISO `YYYY-MM-DD`、给 confidence(0-1)、抽不到返回 `[]`。
   - `embed(text): Promise<number[]>` — 调 Titan V2，返回 1024 维。
4. `web/lib/memory.ts`：
   - `chunkText(text)` — 按段落切块（~500 字符/块）。
   - `writeMemory(...)` — 事务里写 memory_documents + memory_chunks(embedding) + deadlines + agent_events('ingest')。
   - chunk embedding 调用**限并发**（最多 5 个并发，别无脑 Promise.all，Titan 按 RPM 限流）。
5. `web/app/api/ingest/route.ts`：`POST`，接 multipart(file) 或 `{text}`；PDF 用 pdf-parse 抽文本；传 S3；调上面链路；`export const maxDuration = 60;`；返回 `{documentId, deadlines: [...]}`。错误要兜底（Claude 抽取失败/S3 失败分别返回可读错误，别 500 裸奔）。

## Constraints
- 不要动 web/components/ 和任何前端页面（队友的地盘）。
- 不要引入 ORM（Prisma 等），就用 pg + 原生 SQL。
- 不要为多用户/团队做任何抽象，单用户到底。
- schema 向量语法必须对着 CockroachDB v25.x 官方文档，不照抄二手资料。

## Implementation Plan
1. 写 infra/schema.sql（含上面所有修正），本地/CRDB 跑一遍确认无语法错。
2. lib/db.ts 连接池 + 一个 `SELECT 1` 冒烟。
3. lib/bedrock.ts：先 embed 通（打印 1024 维），再 extractDeadlines 通（喂一段假 IRCC 邮件文本，看 JSON）。
4. lib/memory.ts：chunk + 限并发 embed + 事务写库。
5. api/ingest/route.ts 串起来；用 curl 传一个 PDF 验证。

## Acceptance Criteria
- `cockroach sql --url $DATABASE_URL < infra/schema.sql` 无报错，6 张表 + 向量索引建成。
- `curl -F file=@sample.pdf localhost:3000/api/ingest` 返回 JSON，含 ≥1 条 deadline。
- 库里 memory_documents/memory_chunks/deadlines/agent_events 各有对应行，embedding 非空且 1024 维。
- 重复 ingest 同一文件不产生重复 deadline（UNIQUE 生效）。
- Claude 抽取失败时返回结构化错误而非崩溃。

## Review Focus
- 向量索引语法 + cluster setting 是否正确（最容易翻车）。
- 事务边界：4 张表要么全写要么全回滚。
- Titan 并发限流是否真的生效（RPM）。
- 连接池是否复用、有没有连接泄漏。
- PDF 抽取空文本 / 超大文件的边界处理。
