import type { PoolClient } from "pg";
import { createHash } from "crypto";
import { embed, toVectorLiteral, type ExtractedDeadline } from "./bedrock";
import { SYSTEM_USER_ID } from "./constants";
import { query, withTransaction } from "./db";

export interface WriteMemoryInput {
  userId: string;
  text: string;
  sourceType: "pdf" | "text" | "image";
  fileName: string | null;
  mimeType: string | null;
  s3Bucket: string;
  s3Key: string;
  deadlines: ExtractedDeadline[];
}

export interface WriteMemoryResult {
  documentId: string;
  deadlines: ExtractedDeadline[];
}

export interface SearchChunkResult {
  content: string;
  similarity: number;
  source: "user_memory" | "policy";
  source_key: string | null;
  source_title: string | null;
}

export interface DeadlineRow {
  id: string;
  title: string;
  due_date: string;
  description: string | null;
  confidence: number;
  status: "open" | "done" | "dismissed";
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

interface EmbeddedChunk {
  content: string;
  embedding: number[];
}

interface DocumentInsertResult {
  documentId: string;
  inserted: boolean;
}

export function chunkText(text: string, target = 500, overlap = 80): string[] {
  const clean = text.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
  if (!clean) return [];

  const paragraphs = clean
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let buffer = "";

  for (const paragraph of paragraphs) {
    if (buffer && buffer.length + paragraph.length + 2 > target) {
      chunks.push(buffer);
      buffer = overlap > 0 ? `${buffer.slice(-overlap)}\n\n${paragraph}` : paragraph;
    } else {
      buffer = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
    }
  }

  if (buffer) chunks.push(buffer);

  const output: string[] = [];
  const step = Math.max(1, target - overlap);

  for (const chunk of chunks) {
    if (chunk.length <= target * 1.5) {
      output.push(chunk);
      continue;
    }

    for (let index = 0; index < chunk.length; index += step) {
      output.push(chunk.slice(index, index + target).trim());
    }
  }

  return output.filter(Boolean);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

export async function searchChunks(
  userId: string,
  queryEmbedding: number[],
  k = 6
): Promise<SearchChunkResult[]> {
  const limit = Math.max(1, Math.min(20, Math.trunc(k)));
  const result = await query<SearchChunkResult>(
    `SELECT
       memory_chunks.content,
       1 - (memory_chunks.embedding <=> $1::VECTOR(1024)) AS similarity,
       CASE
         WHEN memory_chunks.user_id = $3 THEN 'policy'
         ELSE 'user_memory'
       END AS source,
       memory_documents.source_key,
       memory_documents.file_name AS source_title
     FROM memory_chunks
     JOIN memory_documents
       ON memory_documents.id = memory_chunks.document_id
     WHERE memory_chunks.user_id IN ($2, $3)
     ORDER BY memory_chunks.embedding <=> $1::VECTOR(1024)
     LIMIT $4`,
    [toVectorLiteral(queryEmbedding), userId, SYSTEM_USER_ID, limit]
  );

  return result.rows;
}

export async function openDeadlines(userId: string): Promise<DeadlineRow[]> {
  const result = await query<DeadlineRow>(
    `SELECT
       id,
       title,
       due_date::STRING AS due_date,
       description,
       confidence,
       status,
       created_at::STRING AS created_at,
       updated_at::STRING AS updated_at
     FROM deadlines
     WHERE user_id = $1 AND status = 'open'
     ORDER BY due_date ASC, created_at ASC`,
    [userId]
  );

  return result.rows;
}

export async function recentMessages(userId: string, n = 10): Promise<MessageRow[]> {
  const limit = Math.max(1, Math.min(50, Math.trunc(n)));
  const result = await query<MessageRow>(
    `SELECT id, role, content, created_at::STRING AS created_at
     FROM (
       SELECT id, role, content, created_at
       FROM messages
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2
     ) recent
     ORDER BY created_at ASC`,
    [userId, limit]
  );

  return result.rows;
}

async function insertDocument(
  client: PoolClient,
  input: WriteMemoryInput,
  textHash: string
): Promise<DocumentInsertResult> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO memory_documents (
      user_id,
      source_type,
      file_name,
      mime_type,
      s3_bucket,
      s3_key,
      text_hash,
      text_preview
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (user_id, text_hash) DO NOTHING
    RETURNING id`,
    [
      input.userId,
      input.sourceType,
      input.fileName,
      input.mimeType,
      input.s3Bucket,
      input.s3Key,
      textHash,
      input.text.slice(0, 500),
    ]
  );

  if (result.rows[0]) {
    return { documentId: result.rows[0].id, inserted: true };
  }

  const existing = await client.query<{ id: string }>(
    `SELECT id
     FROM memory_documents
     WHERE user_id = $1 AND text_hash = $2
     LIMIT 1`,
    [input.userId, textHash]
  );

  if (!existing.rows[0]) {
    throw new Error("Unable to find existing memory document after deduplication conflict.");
  }

  return { documentId: existing.rows[0].id, inserted: false };
}

async function findExistingDocument(
  userId: string,
  textHash: string
): Promise<string | null> {
  const result = await query<{ id: string }>(
    `SELECT id
     FROM memory_documents
     WHERE user_id = $1 AND text_hash = $2
     LIMIT 1`,
    [userId, textHash]
  );

  return result.rows[0]?.id ?? null;
}

async function upsertDeadlines(
  client: PoolClient,
  input: WriteMemoryInput,
  documentId: string
): Promise<ExtractedDeadline[]> {
  const insertedDeadlines: ExtractedDeadline[] = [];
  for (const deadline of input.deadlines) {
    const result = await client.query<ExtractedDeadline>(
      `INSERT INTO deadlines (
        user_id,
        document_id,
        title,
        due_date,
        description,
        confidence
      )
      VALUES ($1, $2, $3, $4::DATE, $5, $6)
      ON CONFLICT (user_id, title, due_date)
      DO UPDATE SET
        document_id = EXCLUDED.document_id,
        description = COALESCE(EXCLUDED.description, deadlines.description),
        confidence = GREATEST(deadlines.confidence, EXCLUDED.confidence),
        updated_at = now()
      RETURNING title, due_date::STRING AS due_date, description, confidence`,
      [
        input.userId,
        documentId,
        deadline.title,
        deadline.due_date,
        deadline.description,
        deadline.confidence,
      ]
    );

    insertedDeadlines.push(result.rows[0]);
  }

  return insertedDeadlines;
}

async function insertIngestEvent(
  client: PoolClient,
  input: WriteMemoryInput,
  documentId: string,
  payload: {
    chunkCount: number;
    deadlineCount: number;
    deduped: boolean;
  }
): Promise<void> {
  await client.query(
    `INSERT INTO agent_events (user_id, document_id, event_type, payload)
     VALUES ($1, $2, 'ingest', $3::JSONB)`,
    [
      input.userId,
      documentId,
      JSON.stringify({
        sourceType: input.sourceType,
        fileName: input.fileName,
        chunkCount: payload.chunkCount,
        deadlineCount: payload.deadlineCount,
        deduped: payload.deduped,
      }),
    ]
  );
}

export async function writeMemory(input: WriteMemoryInput): Promise<WriteMemoryResult> {
  const textHash = createHash("sha256").update(input.text).digest("hex");
  const existingDocumentId = await findExistingDocument(input.userId, textHash);

  if (existingDocumentId) {
    return withTransaction(async (client) => {
      await client.query(
        `INSERT INTO users (id, display_name)
         VALUES ($1, $2)
         ON CONFLICT (id) DO NOTHING`,
        [input.userId, "Demo User"]
      );

      const insertedDeadlines = await upsertDeadlines(client, input, existingDocumentId);
      await insertIngestEvent(client, input, existingDocumentId, {
        chunkCount: 0,
        deadlineCount: insertedDeadlines.length,
        deduped: true,
      });

      return {
        documentId: existingDocumentId,
        deadlines: insertedDeadlines,
      };
    });
  }

  const chunks = chunkText(input.text);
  if (chunks.length === 0) {
    throw new Error("No text chunks were available to store.");
  }

  const embeddedChunks = await mapWithConcurrency<string, EmbeddedChunk>(
    chunks,
    5,
    async (content) => ({
      content,
      embedding: await embed(content),
    })
  );

  return withTransaction(async (client) => {
    await client.query(
      `INSERT INTO users (id, display_name)
       VALUES ($1, $2)
       ON CONFLICT (id) DO NOTHING`,
      [input.userId, "Demo User"]
    );

    const { documentId, inserted } = await insertDocument(client, input, textHash);

    if (inserted) {
      for (let index = 0; index < embeddedChunks.length; index += 1) {
        const chunk = embeddedChunks[index];
        await client.query(
          `INSERT INTO memory_chunks (
            document_id,
            user_id,
            chunk_index,
            content,
            embedding
          )
          VALUES ($1, $2, $3, $4, $5::VECTOR(1024))`,
          [documentId, input.userId, index, chunk.content, toVectorLiteral(chunk.embedding)]
        );
      }
    }

    const insertedDeadlines = await upsertDeadlines(client, input, documentId);
    await insertIngestEvent(client, input, documentId, {
      chunkCount: inserted ? embeddedChunks.length : 0,
      deadlineCount: insertedDeadlines.length,
      deduped: !inserted,
    });

    return {
      documentId,
      deadlines: insertedDeadlines,
    };
  });
}
