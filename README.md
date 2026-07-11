# Deadline Copilot

> An agent that never forgets your deadlines — powered by CockroachDB agentic memory on AWS.

Deadline Copilot is an AI agent for international students and newcomers. Drop in an email, PDF, or a photo of a government notice, and it extracts every deadline, builds a durable long-term memory, answers questions grounded in that memory, and proactively reminds you before anything is due.

## Problem

Administrative, immigration, and academic deadlines (study permits, CAQ, PSTQ, H-1B, biometrics, PGWP…) are scattered across emails and PDFs. Missing one is expensive — a lapsed permit or a blown filing window can derail your status. People need a single agent that remembers everything and never lets a date slip.

## What it does

- **Ingest** — Upload a PDF, paste text, or upload an image/scanned notice. Claude (via Amazon Bedrock) extracts structured deadlines; the document is chunked and embedded (Amazon Titan) into CockroachDB for long-term semantic memory. Scanned/image documents are read directly by Claude vision.
- **Chat** — Ask questions in natural language. The agent retrieves relevant memory via CockroachDB vector search, pulls open deadlines, and answers with Claude — grounded only in retrieved context (no hallucinated dates).
- **Deadlines** — List, filter, and mark deadlines done/dismissed.
- **Proactive agent** — A scheduled AWS Lambda scans for upcoming deadlines every day and records reminders — the agent works even when you're not looking.

## Architecture

```
User ──▶ Next.js (AWS Amplify)
             │  /api/ingest · /api/chat · /api/deadlines
             ▼
   Amazon Bedrock  ──  Claude (extraction, vision, chat)
                       Titan Text Embeddings V2 (1024-dim vectors)
   Amazon S3       ──  original uploaded files
   CockroachDB     ──  persistent agentic memory + vector index
             ▲
AWS Lambda + EventBridge (daily deadline-reminder agent)
```

## Agentic memory (four kinds, in CockroachDB)

| Memory | Table | Role |
|--------|-------|------|
| Transactional | `deadlines` | structured deadlines (title, due date, status, confidence) |
| Semantic | `memory_chunks` | document chunks + `VECTOR(1024)` cosine index for retrieval |
| Episodic | `agent_events` | every agent action logged (`ingest`, `answer`, `remind`) |
| Conversational | `messages` | user ↔ assistant chat history |

## CockroachDB tools used

- **Distributed Vector Indexing** — the agent stores Titan embeddings in a `VECTOR(1024)` column with a cosine (`vector_cosine_ops`) index and runs semantic retrieval (`embedding <=> query`) on every chat turn to recall relevant memory.
- **Cloud Managed MCP Server** — the agent connects to the cluster over MCP (read-only, audited) so an AI coding client can query live memory directly.
- **ccloud CLI** — used to provision and manage the CockroachDB Cloud Serverless cluster.

## AWS services used

- **Amazon Bedrock** — Claude (`claude-sonnet-4-5`) for deadline extraction, document/image vision, and grounded chat; Titan Text Embeddings V2 for 1024-dim embeddings.
- **AWS Lambda + EventBridge** — self-contained daily agent that scans open deadlines within 30 days and writes reminder events.
- **Amazon S3** — stores original uploaded documents.
- **AWS Amplify** — hosts the Next.js application.

## Setup & Run

1. **Database** — create a CockroachDB Cloud Serverless cluster (via `ccloud`), then apply the schema:
   ```bash
   cockroach sql --url "$DATABASE_URL" < infra/schema.sql
   ```
2. **Environment** — copy `web/.env.example` to `web/.env.local` and fill in CockroachDB, AWS, Bedrock, and S3 values.
3. **Run**
   ```bash
   cd web && npm install && npm run dev
   ```
4. **Seed demo data** (optional): `cd web && npm run seed`
5. **Reminder Lambda**: see `agent/README.md` for packaging and EventBridge scheduling.

The app exposes `POST /api/ingest`, `POST /api/chat`, and `GET/PATCH /api/deadlines`. A developer test page lives at `/playground`.

## Demo URL / Video / License

- Demo: _TBD_
- Video: _TBD_
- License: [MIT](./LICENSE)
