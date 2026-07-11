import { createHash } from "crypto";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { Pool, type PoolClient } from "pg";

interface KbSource {
  key: string;
  title: string;
  topic: string;
  url: string;
}

interface RefreshResult {
  key: string;
  title: string;
  status: "updated" | "skipped" | "error";
  textHash?: string;
  chunkCount?: number;
  documentId?: string;
  error?: string;
}

interface EmbeddedChunk {
  content: string;
  embedding: number[];
}

const SYSTEM_USER_ID = "00000000-0000-0000-0000-0000000000ff";
const TITAN_DIMENSIONS = 1024;
const FETCH_TIMEOUT_MS = 20_000;
const EMBED_CONCURRENCY = 5;
const USER_AGENT = "DeadlineCopilotKBRefresh/1.0 (+https://example.local)";

let pool: Pool | null = null;
let bedrockClient: BedrockRuntimeClient | null = null;

function getPool(): Pool {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not configured.");
  }

  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 2,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
  }

  return pool;
}

function getBedrockClient(): BedrockRuntimeClient {
  if (!bedrockClient) {
    bedrockClient = new BedrockRuntimeClient({
      region: process.env.AWS_REGION || "us-east-1",
    });
  }

  return bedrockClient;
}

function loadSources(): KbSource[] {
  const sourcePath = process.env.KB_SOURCES_PATH || resolve(__dirname, "../infra/kb-sources.json");
  const parsed = JSON.parse(readFileSync(sourcePath, "utf8")) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("KB sources must contain an array.");
  }

  return parsed.map((item) => {
    const source = item as Partial<KbSource>;
    if (!source.key || !source.title || !source.topic || !source.url) {
      throw new Error("Each KB source must include key, title, topic, and url.");
    }
    return {
      key: source.key,
      title: source.title,
      topic: source.topic,
      url: source.url,
    };
  });
}

async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();

  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
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

function chunkText(text: string, target = 500, overlap = 80): string[] {
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

function decodeHtmlEntities(text: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: "\"",
    apos: "'",
    nbsp: " ",
  };

  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (entity, value: string) => {
    const lower = value.toLowerCase();
    if (lower.startsWith("#x")) {
      const codePoint = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : entity;
    }
    if (lower.startsWith("#")) {
      const codePoint = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : entity;
    }
    return named[lower] ?? entity;
  });
}

function htmlToText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
      .replace(/<(nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<\/(p|div|section|article|main|li|tr|h[1-6])>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function fetchSourceText(source: KbSource): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(source.url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Fetch failed with HTTP ${response.status}.`);
    }

    const body = await response.text();
    const contentType = response.headers.get("content-type") || "";
    const text = contentType.includes("text/plain") ? body.trim() : htmlToText(body);
    if (!text) {
      throw new Error("Fetched source did not contain extractable text.");
    }
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

function decodeJsonBody<T>(body: Uint8Array): T {
  return JSON.parse(new TextDecoder().decode(body)) as T;
}

async function embed(text: string): Promise<number[]> {
  const modelId = process.env.BEDROCK_TITAN_MODEL_ID || "amazon.titan-embed-text-v2:0";
  const result = await getBedrockClient().send(
    new InvokeModelCommand({
      modelId,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({
        inputText: text.slice(0, 8_000),
        dimensions: TITAN_DIMENSIONS,
        normalize: true,
      }),
    })
  );

  if (!result.body) {
    throw new Error("Titan returned an empty response.");
  }

  const payload = decodeJsonBody<{ embedding?: unknown }>(result.body);
  if (!Array.isArray(payload.embedding)) {
    throw new Error("Titan response did not include an embedding array.");
  }

  const vector = payload.embedding.map(Number);
  if (vector.length !== TITAN_DIMENSIONS || vector.some((value) => !Number.isFinite(value))) {
    throw new Error(`Titan embedding must contain ${TITAN_DIMENSIONS} numeric dimensions.`);
  }

  return vector;
}

function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

async function existingHash(sourceKey: string): Promise<string | null> {
  const result = await getPool().query<{ text_hash: string }>(
    `SELECT text_hash
     FROM memory_documents
     WHERE user_id = $1 AND source_key = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [SYSTEM_USER_ID, sourceKey]
  );

  return result.rows[0]?.text_hash ?? null;
}

async function insertPolicyDocument(
  client: PoolClient,
  source: KbSource,
  text: string,
  textHash: string
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO memory_documents (
      user_id,
      source_type,
      source_key,
      file_name,
      mime_type,
      s3_bucket,
      s3_key,
      text_hash,
      text_preview
    )
    VALUES ($1, 'policy', $2, $3, 'text/plain', 'official-url', $4, $5, $6)
    RETURNING id`,
    [SYSTEM_USER_ID, source.key, source.title, source.url, textHash, text.slice(0, 500)]
  );

  return result.rows[0].id;
}

async function refreshSource(source: KbSource): Promise<RefreshResult> {
  const text = await fetchSourceText(source);
  const textHash = createHash("sha256").update(text).digest("hex");
  const currentHash = await existingHash(source.key);

  if (currentHash === textHash) {
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO users (id, display_name)
         VALUES ($1, 'System Policy KB')
         ON CONFLICT (id) DO NOTHING`,
        [SYSTEM_USER_ID]
      );
      await client.query(
        `INSERT INTO agent_events (user_id, event_type, payload)
         VALUES ($1, 'kb_refresh', $2::JSONB)`,
        [
          SYSTEM_USER_ID,
          JSON.stringify({
            sourceKey: source.key,
            title: source.title,
            url: source.url,
            changed: false,
            skipped: true,
            chunkCount: 0,
          }),
        ]
      );
    });

    return {
      key: source.key,
      title: source.title,
      status: "skipped",
      textHash,
      chunkCount: 0,
    };
  }

  const chunks = chunkText(text);
  if (chunks.length === 0) {
    throw new Error("No text chunks were available to store.");
  }

  const embeddedChunks = await mapWithConcurrency<string, EmbeddedChunk>(
    chunks,
    EMBED_CONCURRENCY,
    async (content) => ({
      content,
      embedding: await embed(content),
    })
  );

  return withTransaction(async (client) => {
    await client.query(
      `INSERT INTO users (id, display_name)
       VALUES ($1, 'System Policy KB')
       ON CONFLICT (id) DO NOTHING`,
      [SYSTEM_USER_ID]
    );

    await client.query(
      `DELETE FROM memory_documents
       WHERE user_id = $1 AND source_key = $2`,
      [SYSTEM_USER_ID, source.key]
    );

    const documentId = await insertPolicyDocument(client, source, text, textHash);

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
        [documentId, SYSTEM_USER_ID, index, chunk.content, toVectorLiteral(chunk.embedding)]
      );
    }

    await client.query(
      `INSERT INTO agent_events (user_id, document_id, event_type, payload)
       VALUES ($1, $2, 'kb_refresh', $3::JSONB)`,
      [
        SYSTEM_USER_ID,
        documentId,
        JSON.stringify({
          sourceKey: source.key,
          title: source.title,
          url: source.url,
          changed: true,
          skipped: false,
          chunkCount: embeddedChunks.length,
        }),
      ]
    );

    return {
      key: source.key,
      title: source.title,
      status: "updated",
      textHash,
      chunkCount: embeddedChunks.length,
      documentId,
    };
  });
}

async function refreshAll(): Promise<RefreshResult[]> {
  const sources = loadSources();
  const results: RefreshResult[] = [];

  for (const source of sources) {
    try {
      results.push(await refreshSource(source));
    } catch (error) {
      results.push({
        key: source.key,
        title: source.title,
        status: "error",
        error: error instanceof Error ? error.message : "Unknown KB refresh error.",
      });
    }
  }

  return results;
}

export const handler = async (): Promise<{ results: RefreshResult[]; error?: string }> => {
  try {
    return { results: await refreshAll() };
  } catch (error) {
    return {
      results: [],
      error: error instanceof Error ? error.message : "Unknown KB refresh handler error.",
    };
  }
};
