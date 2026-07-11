import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import type { PoolClient } from "pg";
import { embed, toVectorLiteral } from "./bedrock";
import { SYSTEM_USER_ID } from "./constants";
import { query, withTransaction } from "./db";
import { chunkText } from "./memory";

export interface KbSource {
  key: string;
  title: string;
  topic: string;
  url: string;
}

export type KbRefreshStatus = "updated" | "skipped" | "error";

export interface KbRefreshResult {
  key: string;
  title: string;
  status: KbRefreshStatus;
  textHash?: string;
  chunkCount?: number;
  documentId?: string;
  error?: string;
}

interface EmbeddedChunk {
  content: string;
  embedding: number[];
}

const FETCH_TIMEOUT_MS = 20_000;
const EMBED_CONCURRENCY = 5;
const USER_AGENT = "DeadlineCopilotKBRefresh/1.0 (+https://example.local)";

function loadSources(): KbSource[] {
  const candidates = [
    resolve(process.cwd(), "../infra/kb-sources.json"),
    resolve(process.cwd(), "infra/kb-sources.json"),
  ];
  const sourcePath = candidates.find((candidate) => existsSync(candidate));
  if (!sourcePath) {
    throw new Error("infra/kb-sources.json was not found.");
  }

  const parsed = JSON.parse(readFileSync(sourcePath, "utf8")) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("infra/kb-sources.json must contain an array.");
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

export function htmlToText(html: string): string {
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

async function existingHash(sourceKey: string): Promise<string | null> {
  const result = await query<{ text_hash: string }>(
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

export async function refreshSource(source: KbSource): Promise<KbRefreshResult> {
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

export async function refreshAll(): Promise<KbRefreshResult[]> {
  const sources = loadSources();
  const results: KbRefreshResult[] = [];

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
