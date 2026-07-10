# Handoff: Backend Foundation

## Files created/changed

- `infra/schema.sql`
- `web/lib/db.ts`
- `web/lib/bedrock.ts`
- `web/lib/memory.ts`
- `web/app/api/ingest/route.ts`
- `.ai/HANDOFF.md`

## What was verified

- `web/`: `npx tsc --noEmit` passed.
- `web/`: `npm run lint` passed.
- `infra/schema.sql` static sanity passed:
  - file starts with `SET CLUSTER SETTING feature.vector_index.enabled = true;`
  - six required tables are present
  - `memory_chunks.embedding` uses `VECTOR(1024)`
  - cosine vector index line is `CREATE VECTOR INDEX ON memory_chunks (embedding vector_cosine_ops);`
  - `deadlines` has `UNIQUE (user_id, title, due_date)`
  - `deadlines` has a `(user_id, due_date)` index

## Pending live infra

- Run `cockroach sql --url $DATABASE_URL < infra/schema.sql` against a real CockroachDB v25.x cluster and confirm all six tables plus the vector index are created.
- Run a DB smoke query through `web/lib/db.ts` once `DATABASE_URL` is configured.
- Call Titan V2 through Bedrock and confirm `embed()` returns exactly 1024 dimensions.
- Call Claude through Bedrock with representative IRCC/deadline text and confirm `extractDeadlines()` returns the expected JSON array.
- Start the Next.js app and run `curl -F file=@sample.pdf localhost:3000/api/ingest`; confirm the response includes `{ documentId, deadlines }`.
- Verify CockroachDB rows are written to `memory_documents`, `memory_chunks`, `deadlines`, and `agent_events`, with non-empty 1024-dimension embeddings.
- Repeat ingest of the same deadline and confirm `UNIQUE (user_id, title, due_date)` prevents duplicate deadline rows.
- Force Claude, Titan, S3, and DB failures with live credentials/config and confirm structured error responses.

## Key decisions and risks for Claude review

- Bedrock Claude request/response shape uses the Anthropic Messages payload for Bedrock: `anthropic_version: "bedrock-2023-05-31"`, a single user text message, and response text read from `content[].text`. This passed TypeScript only; live Bedrock model access still needs confirmation.
- Titan V2 embedding request uses `{ inputText, dimensions: 1024, normalize: true }` and validates the returned `embedding` array length. This matches the intended Titan V2 shape but still needs a live Bedrock call.
- `pdf-parse` v2 usage is `new PDFParse({ data: buffer })`, `await parser.getText()`, and `await parser.destroy()` in `finally`. This follows the v2 class API and passed TypeScript.
- Embedding concurrency is limited with a small in-process worker pool capped at 5 concurrent Titan calls. It preserves chunk order, but it does not implement retry/backoff for Bedrock throttling.
- Transaction boundaries cover CockroachDB writes only: `users` upsert, `memory_documents`, `memory_chunks`, `deadlines`, and `agent_events` are all inside one transaction. S3 upload, Claude extraction, and Titan embeddings happen before the DB transaction, so failed DB writes can leave an uploaded S3 object with no DB row.
- Deadline de-duplication uses `ON CONFLICT (user_id, title, due_date) DO UPDATE` so repeated ingest updates source metadata/confidence instead of inserting another deadline.
- Vector values are passed as pg parameters and cast with `$5::VECTOR(1024)`. This is statically type-safe from the app side, but the exact CockroachDB parameter cast behavior should be confirmed live.
