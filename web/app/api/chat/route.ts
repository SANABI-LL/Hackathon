import { NextResponse } from "next/server";
import { answer, embed } from "@/lib/bedrock";
import { withTransaction } from "@/lib/db";
import {
  openDeadlines,
  recentMessages,
  searchChunks,
  type DeadlineRow,
  type MessageRow,
  type SearchChunkResult,
} from "@/lib/memory";

export const maxDuration = 60;
export const runtime = "nodejs";

interface ChatPayload {
  message?: unknown;
}

function jsonError(message: string, status: number, code: string): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status });
}

function getUserId(): string {
  return process.env.APP_USER_ID || "00000000-0000-0000-0000-000000000001";
}

function readMessage(payload: ChatPayload): string {
  if (typeof payload.message !== "string" || !payload.message.trim()) {
    throw new Error("Send a JSON body with a non-empty message field.");
  }

  return payload.message.trim();
}

function formatMemorySources(sources: SearchChunkResult[]): string {
  if (sources.length === 0) return "No retrieved memory excerpts.";

  return sources
    .map((source, index) => {
      const sourceLabel =
        source.source === "policy"
          ? `policy${source.source_key ? `:${source.source_key}` : ""}`
          : "user memory";
      const title = source.source_title ? ` | ${source.source_title}` : "";
      return `[Memory ${index + 1} | ${sourceLabel}${title} | similarity ${source.similarity.toFixed(3)}]\n${source.content}`;
    })
    .join("\n\n");
}

function formatDeadlines(deadlines: DeadlineRow[]): string {
  if (deadlines.length === 0) return "No open deadlines.";

  return deadlines
    .map((deadline) => {
      const description = deadline.description ? ` Description: ${deadline.description}` : "";
      return `- ${deadline.title}: due ${deadline.due_date}, status ${deadline.status}, confidence ${deadline.confidence}.${description}`;
    })
    .join("\n");
}

function formatRecentMessages(messages: MessageRow[]): string {
  if (messages.length === 0) return "No recent messages.";

  return messages
    .map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.content}`)
    .join("\n");
}

function buildContext(input: {
  sources: SearchChunkResult[];
  deadlines: DeadlineRow[];
  messages: MessageRow[];
}): string {
  return [
    "Retrieved memory excerpts:",
    formatMemorySources(input.sources),
    "",
    "Open deadlines:",
    formatDeadlines(input.deadlines),
    "",
    "Recent conversation:",
    formatRecentMessages(input.messages),
  ].join("\n");
}

export async function POST(request: Request): Promise<NextResponse> {
  const userId = getUserId();
  let message: string;

  try {
    message = readMessage((await request.json()) as ChatPayload);
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Unable to read the chat request.",
      400,
      "INVALID_CHAT_REQUEST"
    );
  }

  let embedding: number[];
  try {
    embedding = await embed(message);
  } catch (error) {
    return jsonError(
      `Message embedding failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      502,
      "MESSAGE_EMBEDDING_FAILED"
    );
  }

  let sources: SearchChunkResult[];
  let deadlines: DeadlineRow[];
  let messages: MessageRow[];
  try {
    [sources, deadlines, messages] = await Promise.all([
      searchChunks(userId, embedding, 6),
      openDeadlines(userId),
      recentMessages(userId, 10),
    ]);
  } catch (error) {
    return jsonError(
      `Context retrieval failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      500,
      "CONTEXT_RETRIEVAL_FAILED"
    );
  }

  let assistantAnswer: string;
  try {
    assistantAnswer = await answer(
      message,
      buildContext({
        sources,
        deadlines,
        messages,
      })
    );
  } catch (error) {
    return jsonError(
      `Answer generation failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      502,
      "ANSWER_GENERATION_FAILED"
    );
  }

  try {
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO users (id, display_name)
         VALUES ($1, $2)
         ON CONFLICT (id) DO NOTHING`,
        [userId, "Demo User"]
      );

      await client.query(
        `INSERT INTO messages (user_id, role, content)
         VALUES ($1, 'user', $2), ($1, 'assistant', $3)`,
        [userId, message, assistantAnswer]
      );

      await client.query(
        `INSERT INTO agent_events (user_id, event_type, payload)
         VALUES ($1, 'answer', $2::JSONB)`,
        [
          userId,
          JSON.stringify({
            question: message,
            answer: assistantAnswer,
            sourceCount: sources.length,
            openDeadlineCount: deadlines.length,
          }),
        ]
      );
    });
  } catch (error) {
    return jsonError(
      `Conversation write failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      500,
      "CONVERSATION_WRITE_FAILED"
    );
  }

  return NextResponse.json({
    answer: assistantAnswer,
    sources,
  });
}
