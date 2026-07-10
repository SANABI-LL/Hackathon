import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";

export interface ExtractedDeadline {
  title: string;
  due_date: string;
  description: string | null;
  confidence: number;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TITAN_DIMENSIONS = 1024;

let bedrockClient: BedrockRuntimeClient | null = null;

function getBedrockClient(): BedrockRuntimeClient {
  if (!bedrockClient) {
    bedrockClient = new BedrockRuntimeClient({
      region: process.env.AWS_REGION || "us-east-1",
    });
  }

  return bedrockClient;
}

function decodeJsonBody<T>(body: Uint8Array): T {
  return JSON.parse(new TextDecoder().decode(body)) as T;
}

export function parseJsonArray(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return JSON.parse(trimmed);
  }

  const match = text.match(/\[[\s\S]*\]/);
  if (!match) {
    throw new Error("Claude did not return a JSON array.");
  }

  return JSON.parse(match[0]);
}

export function normalizeDeadline(value: unknown): ExtractedDeadline | null {
  if (!value || typeof value !== "object") return null;

  const item = value as Record<string, unknown>;
  const title = typeof item.title === "string" ? item.title.trim() : "";
  const dueDate = typeof item.due_date === "string" ? item.due_date.trim() : "";
  const description =
    typeof item.description === "string" && item.description.trim()
      ? item.description.trim()
      : null;
  const confidence =
    typeof item.confidence === "number" && Number.isFinite(item.confidence)
      ? Math.max(0, Math.min(1, item.confidence))
      : 0;

  if (!title || !ISO_DATE.test(dueDate)) return null;

  return {
    title,
    due_date: dueDate,
    description,
    confidence,
  };
}

function textFromClaudeResponse(response: unknown): string {
  const content = (response as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";

  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const text = (block as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .filter(Boolean)
    .join("\n");
}

export async function extractDeadlines(text: string): Promise<ExtractedDeadline[]> {
  const modelId = process.env.BEDROCK_CLAUDE_MODEL_ID;
  if (!modelId) {
    throw new Error("BEDROCK_CLAUDE_MODEL_ID is not configured.");
  }

  const prompt = [
    "Extract every explicit deadline, expiration date, appointment due date, renewal date, filing date, or required action date from the document.",
    "Return only a JSON array. Do not include markdown, explanations, or surrounding text.",
    "Each array item must use exactly this shape: {\"title\":\"short deadline title\",\"due_date\":\"YYYY-MM-DD\",\"description\":\"brief source-grounded description or null\",\"confidence\":0.0}.",
    "Use ISO calendar dates only in YYYY-MM-DD format. If the year is not clear from the document, omit that deadline.",
    "Use confidence from 0 to 1 based on how explicit the date and action are.",
    "If there are no clear deadlines, return [].",
    "",
    "Document:",
    text.slice(0, 80_000),
  ].join("\n");

  const command = new InvokeModelCommand({
    modelId,
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 1200,
      temperature: 0,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: prompt }],
        },
      ],
    }),
  });

  const result = await getBedrockClient().send(command);
  if (!result.body) {
    throw new Error("Claude returned an empty response.");
  }

  const rawText = textFromClaudeResponse(decodeJsonBody<unknown>(result.body));
  const parsed = parseJsonArray(rawText);
  if (!Array.isArray(parsed)) {
    throw new Error("Claude response was not a JSON array.");
  }

  return parsed
    .map(normalizeDeadline)
    .filter((deadline): deadline is ExtractedDeadline => Boolean(deadline));
}

export async function embed(text: string): Promise<number[]> {
  const modelId = process.env.BEDROCK_TITAN_MODEL_ID || "amazon.titan-embed-text-v2:0";
  const command = new InvokeModelCommand({
    modelId,
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify({
      inputText: text.slice(0, 8_000),
      dimensions: TITAN_DIMENSIONS,
      normalize: true,
    }),
  });

  const result = await getBedrockClient().send(command);
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

export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}
