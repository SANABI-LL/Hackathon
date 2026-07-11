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

## Fix round 1 (review items)

- Fix #1 document/chunk de-duplication: `memory_documents` now has `UNIQUE (user_id, text_hash)`. `writeMemory()` computes the SHA-256 text hash before Titan embedding, checks for an existing `(user_id, text_hash)` document, and reuses its `documentId` when present. Duplicate ingests skip chunk embedding and `memory_chunks` inserts, still upsert deadlines, and still write an `agent_events('ingest')` row with `deduped: true`. The insert path also uses `ON CONFLICT (user_id, text_hash) DO NOTHING` so a concurrent duplicate insert reuses the existing document instead of creating duplicate chunks.
- Fix #2 upload size limit: `/api/ingest` now enforces a named 10 MB `MAX_UPLOAD_BYTES` limit. It rejects oversized requests from `Content-Length` before body parsing where possible and also checks multipart files, buffered text fields, and JSON bodies after buffering as a fallback. Oversized input returns HTTP 413 with `{ error: { code: "FILE_TOO_LARGE", message } }`.
- Fix #4 pure-function tests: added `npm run test` as `vitest run`, exported `normalizeDeadline` and `parseJsonArray`, and added Vitest coverage for `chunkText`, `normalizeDeadline`, and `parseJsonArray` under `web/lib/__tests__/`. These tests do not call network, DB, S3, or Bedrock.

Verification:

- `cd web && npx tsc --noEmit`: passed, 0 TypeScript errors.
- `cd web && npm run lint`: passed, 0 ESLint errors.
- `cd web && npm run test`: passed, 2 test files and 14 tests.

Decisions/risks:

- The duplicate pre-check is intentionally outside the write transaction to avoid Titan calls for already-ingested text; all DB writes remain inside a single transaction.
- A true concurrent duplicate can still do redundant Titan work if both requests pass the pre-check before either inserts, but the unique constraint and conflict handling prevent duplicate documents/chunks from being written.

## Round 2

Files changed:

- `web/lib/bedrock.ts`
- `web/lib/memory.ts`
- `web/app/api/chat/route.ts`
- `web/app/api/deadlines/route.ts`
- `web/app/playground/page.tsx`
- `.ai/HANDOFF.md`

Static verification:

- `cd web && npx tsc --noEmit`: passed, 0 TypeScript errors.
- `cd web && npm run lint`: passed, 0 ESLint errors.
- `cd web && npm run test`: passed, 2 test files and 14 tests.

Key decisions:

- Chat context assembly combines three sections: vector-retrieved `memory_chunks`, open deadlines, and the last 10 messages in chronological order. The Claude prompt in `answer()` instructs the model to answer only from that context, use English, include exact dates when supported, and say it does not know when context is insufficient.
- Vector retrieval is raw parameterized SQL using the existing `toVectorLiteral()` helper, cosine distance with `embedding <=> $1::VECTOR(1024)`, and ascending distance order. Similarity is returned as `1 - distance`.
- `/api/chat` does Bedrock embedding, DB context retrieval, and Bedrock answer generation before opening the write transaction. The transaction covers the user upsert, user/assistant message inserts, and `agent_events('answer')` insert together.
- `/api/deadlines` uses raw parameterized SQL only. `GET` optionally filters by a validated status and orders by due date. `PATCH` validates `status` against `open|done|dismissed`, updates `status` and `updated_at`, and scopes the update to `APP_USER_ID`.
- `/playground` is a standalone `"use client"` route. It calls `/api/ingest` with `{ text }`, refreshes `/api/deadlines`, patches rows to `done`, and posts chat messages to `/api/chat`, then displays the answer and retrieved sources. It does not import or modify the teammate-owned page/layout/components.

Review notes:

- No live DB, Bedrock, S3, or HTTP calls were attempted from the sandbox.
- `web/app/page.tsx`, `web/app/layout.tsx`, and `web/components/` were not modified.
- The initial playground deadline refresh has a narrow ESLint suppression for `react-hooks/set-state-in-effect`; this page is dev-only and intentionally loads backend state when opened.

## Round 3

Files changed:

- `web/lib/bedrock.ts`
- `web/app/api/ingest/route.ts`
- `web/lib/memory.ts`
- `web/lib/__tests__/bedrock.test.ts`
- `agent/handler.ts`
- `agent/package.json`
- `agent/README.md`
- `scripts/seed.ts`
- `web/package.json`
- `.ai/HANDOFF.md`

Static verification:

- `cd web && npx tsc --noEmit`: passed, 0 TypeScript errors.
- `cd web && npm run lint`: passed, 0 ESLint errors.
- `cd web && npm run test`: passed, 2 test files and 19 tests.

Multimodal content-block decision:

- `extractFromMedia()` uses Bedrock `InvokeModel` with Anthropic Messages payloads, `anthropic_version: "bedrock-2023-05-31"`, `BEDROCK_CLAUDE_MODEL_ID`, `temperature: 0`, and `max_tokens: 4000`.
- PDF input is sent as a `document` block with `{ type: "base64", media_type: "application/pdf", data }`, followed by a text prompt requesting `{"transcript":"...","deadlines":[...]}`.
- PNG/JPEG input is sent as an `image` block with `{ type: "base64", media_type: "image/png"|"image/jpeg", data }`, followed by the same JSON prompt.
- Returned deadlines are normalized through the existing `normalizeDeadline()` path. The returned transcript becomes the document text used by existing `writeMemory()` chunking and Titan embedding.
- Text PDFs still try `pdf-parse` first. If extracted text is at least 120 characters, the existing text extraction path is used. Empty/scanned PDFs fall back to Claude multimodal extraction.
- If Bedrock rejects PDF document blocks for the configured model or region, the API returns a structured `MULTIMODAL_EXTRACTION_FAILED` error that explicitly notes PDF document block support may be unavailable.

Reminder Lambda:

- `agent/handler.ts` is self-contained and imports only `pg`.
- It scans `status = 'open'` deadlines due from today through `REMINDER_WINDOW_DAYS` days, defaulting to 30.
- It avoids duplicate same-day reminders with a `NOT EXISTS` check against `agent_events` where `event_type = 'remind'`, `payload->>'deadlineId'` matches, and `created_at` is within the current calendar day.
- It writes `agent_events('remind')` payloads shaped as `{deadlineId,title,dueDate,daysLeft}` and returns `{scanned, remindersCreated}`. Caught errors return an error summary instead of throwing a raw Lambda failure.

Seed script:

- `scripts/seed.ts` loads `web/.env.local`, uses existing `extractDeadlines()` and `writeMemory()`, and inserts four realistic IRCC/CAQ/work-permit/passport-request samples.
- Idempotency relies on the existing `memory_documents` `(user_id, text_hash)` dedup in `writeMemory()`, so repeated seed runs reuse documents instead of duplicating chunks.
- `web/package.json` has `npm run seed` as `tsx ../scripts/seed.ts`.

Pending live verification:

- No live DB, Bedrock, S3, HTTP, or seed execution was attempted from the sandbox.
- Upload PNG/JPEG and scanned PDF samples through `/api/ingest`; confirm Claude returns transcript plus deadlines and `memory_chunks` store transcript embeddings.
- Upload a text PDF and confirm it stays on the `pdf-parse` text path.
- Confirm the configured Sonnet 4.5 Bedrock model accepts Anthropic PDF `document` blocks via `InvokeModel`; if not, keep the structured failure and consider an OCR/PDF raster fallback.
- Run the Lambda against a real DB or local mock data; confirm one remind event is created per due deadline per day and repeat runs do not duplicate same-day reminders.
- Run `cd web && npm run seed` with live env; confirm sample documents/deadlines are created and a second run does not duplicate chunks or documents.

## Round 4 (KB refresh)

Files changed:

- `infra/schema.sql`
- `infra/kb-sources.json`
- `web/lib/constants.ts`
- `web/lib/kb.ts`
- `web/lib/memory.ts`
- `web/app/api/chat/route.ts`
- `web/lib/__tests__/kb.test.ts`
- `scripts/refresh-kb.ts`
- `web/package.json`
- `agent/kb-handler.ts`
- `agent/package.json`
- `agent/package-lock.json`
- `agent/README.md`
- `.ai/HANDOFF.md`

Static verification:

- `cd web && npx tsc --noEmit`: passed, 0 TypeScript errors.
- `cd web && npm run lint`: passed, 0 ESLint errors.
- `cd web && npm run test`: passed, 3 test files and 21 tests.

HTML-extraction approach:

- `web/lib/kb.ts` fetches official URLs with a `User-Agent`, `Accept` header, and `AbortController` timeout.
- HTML is converted to plain text with deterministic stripping only: removes `script`, `style`, `noscript`, `svg`, `nav`, `header`, `footer`, `aside`, and comments; converts common block endings and `<br>` to line breaks; removes remaining tags; decodes common/numeric HTML entities; normalizes whitespace.
- No LLM is used for policy cleaning or rewriting, so stored policy chunks remain source-faithful to fetched page text.
- Added pure tests for script/style/nav/footer removal, entity decoding, and whitespace normalization.

Search behavior:

- `SYSTEM_USER_ID` is fixed as `00000000-0000-0000-0000-0000000000ff` in `web/lib/constants.ts` and mirrored in the self-contained Lambda.
- `searchChunks(userId, ...)` now joins `memory_documents` and retrieves `memory_chunks.user_id IN ($user, $system)`.
- Each result includes `source: 'user_memory' | 'policy'`, nullable `source_key`, and nullable `source_title`; `/api/chat` includes that source label in the context block sent to Claude.

Pending live items:

- Apply the live DB migration with `ALTER TABLE memory_documents ADD COLUMN IF NOT EXISTS source_key STRING;` and add the optional `(user_id, source_key)` index if desired.
- Run `cd web && npm run refresh-kb` with live `DATABASE_URL` and Bedrock access; confirm first run updates/embeds all reachable official sources and second run skips unchanged hashes.
- Confirm changed-source replacement deletes the prior `SYSTEM_USER_ID + source_key` document and its chunks through cascade before inserting the new document and chunks.
- Package/deploy `agent/kb-handler.ts` as a separate Lambda with `infra/kb-sources.json` included or `KB_SOURCES_PATH` set, then attach a separate daily EventBridge rule.
- Run `cd agent && npm install` with network access before deployment packaging to validate/refresh the copied `@aws-sdk/client-bedrock-runtime` lockfile metadata. Sandbox npm attempts failed with `ENOTFOUND`/`ENOTCACHED`.
- No live DB, Bedrock, S3, or network fetches were attempted from the sandbox.
