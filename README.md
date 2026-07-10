# Deadline Copilot

> An agent that never forgets your deadlines — powered by CockroachDB agentic memory on AWS.

## Problem
留学生 / 新移民的行政 · 移民 · 学业 deadline 分散在邮件和 PDF 里，漏一个代价极高（签证过期、CAQ/PSTQ 截止）。Deadline Copilot 把邮件/PDF 丢进去，自动抽取 deadline、建立长期记忆、到点主动提醒并给出下一步动作。

## Architecture
```
用户 → Next.js (AWS Amplify) → API routes ──→ Amazon Bedrock (Claude 抽取/对话 · Titan 向量)
                                    │          Amazon S3 (PDF 原件)
                                    └────────→ CockroachDB (持久记忆层 · 向量索引)
AWS Lambda + EventBridge (每日定时 agent 扫描 deadline → 主动提醒)
```

## CockroachDB tools used
- **Distributed Vector Indexing** — the agent 用 cosine 向量索引语义检索 `memory_chunks`，做长期记忆召回。
- **Cloud Managed MCP Server** — the agent 通过 MCP（只读 + 审计日志）直接查询记忆库。
- **ccloud CLI** — 建集群 / 备份 / 配置管理。

## AWS services used
- **Amazon Bedrock** — Claude 结构化抽取 deadline + 对话；Titan Text Embeddings V2 (1024 维) 生成 embedding。
- **AWS Lambda + EventBridge** — 每日定时扫描临近 deadline，主动生成提醒。
- **Amazon S3** — 存用户上传的 PDF 原件。

## Setup & Run
1. 复制 `.env.example` → `.env.local`，填 CockroachDB / AWS / Bedrock 配置。
2. 建集群并跑 schema：`cockroach sql --url $DATABASE_URL < infra/schema.sql`
3. `cd web && npm install && npm run dev`

## Demo URL / Video / License
- Demo: _TBD_
- Video: _TBD_
- License: [MIT](./LICENSE)
