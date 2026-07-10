import type { PoolClient } from "pg";
import { createHash } from "crypto";
import { embed, toVectorLiteral, type ExtractedDeadline } from "./bedrock";
import { withTransaction } from "./db";

export interface WriteMemoryInput {
  userId: string;
  text: string;
  sourceType: "pdf" | "text";
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

interface EmbeddedChunk {
  content: string;
  embedding: number[];
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

async function insertDocument(
  client: PoolClient,
  input: WriteMemoryInput
): Promise<string> {
  const textHash = createHash("sha256").update(input.text).digest("hex");
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

  return result.rows[0].id;
}

export async function writeMemory(input: WriteMemoryInput): Promise<WriteMemoryResult> {
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

    const documentId = await insertDocument(client, input);

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

    await client.query(
      `INSERT INTO agent_events (user_id, document_id, event_type, payload)
       VALUES ($1, $2, 'ingest', $3::JSONB)`,
      [
        input.userId,
        documentId,
        JSON.stringify({
          sourceType: input.sourceType,
          fileName: input.fileName,
          chunkCount: embeddedChunks.length,
          deadlineCount: insertedDeadlines.length,
        }),
      ]
    );

    return {
      documentId,
      deadlines: insertedDeadlines,
    };
  });
}
