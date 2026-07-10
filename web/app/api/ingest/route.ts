import { NextResponse } from "next/server";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createHash, randomUUID } from "crypto";
import { PDFParse } from "pdf-parse";
import { extractDeadlines } from "@/lib/bedrock";
import { writeMemory } from "@/lib/memory";

export const maxDuration = 60;
export const runtime = "nodejs";

interface IngestPayload {
  text?: unknown;
}

let s3Client: S3Client | null = null;

function getS3Client(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({
      region: process.env.AWS_REGION || "us-east-1",
    });
  }

  return s3Client;
}

function jsonError(message: string, status: number, code: string): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status });
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });

  try {
    const result = await parser.getText();
    return result.text.trim();
  } finally {
    await parser.destroy();
  }
}

async function readRequest(request: Request): Promise<{
  body: Buffer;
  text: string;
  sourceType: "pdf" | "text";
  fileName: string | null;
  mimeType: string | null;
}> {
  const contentType = request.headers.get("content-type") || "";

  if (contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
    const file = formData.get("file");
    const textField = formData.get("text");

    if (file instanceof File) {
      const arrayBuffer = await file.arrayBuffer();
      const body = Buffer.from(arrayBuffer);
      const mimeType = file.type || "application/octet-stream";
      const isPdf =
        mimeType === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
      const text = isPdf ? await extractPdfText(body) : body.toString("utf8").trim();

      return {
        body,
        text,
        sourceType: isPdf ? "pdf" : "text",
        fileName: file.name || "upload",
        mimeType,
      };
    }

    if (typeof textField === "string" && textField.trim()) {
      const text = textField.trim();
      return {
        body: Buffer.from(text, "utf8"),
        text,
        sourceType: "text",
        fileName: "pasted-text.txt",
        mimeType: "text/plain",
      };
    }
  }

  if (contentType.includes("application/json")) {
    const payload = (await request.json()) as IngestPayload;
    if (typeof payload.text === "string" && payload.text.trim()) {
      const text = payload.text.trim();
      return {
        body: Buffer.from(text, "utf8"),
        text,
        sourceType: "text",
        fileName: "pasted-text.txt",
        mimeType: "text/plain",
      };
    }
  }

  throw new Error("Send a multipart file field or a JSON body with a non-empty text field.");
}

async function uploadToS3(input: {
  body: Buffer;
  fileName: string | null;
  mimeType: string | null;
  userId: string;
}): Promise<{ bucket: string; key: string }> {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) {
    throw new Error("S3_BUCKET is not configured.");
  }

  const safeName = (input.fileName || "document")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .slice(0, 120);
  const digest = createHash("sha256").update(input.body).digest("hex").slice(0, 16);
  const key = `${input.userId}/ingest/${Date.now()}-${digest}-${randomUUID()}-${safeName}`;

  await getS3Client().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: input.body,
      ContentType: input.mimeType || "application/octet-stream",
    })
  );

  return { bucket, key };
}

export async function POST(request: Request): Promise<NextResponse> {
  const userId = process.env.APP_USER_ID || "00000000-0000-0000-0000-000000000001";

  let parsedRequest: Awaited<ReturnType<typeof readRequest>>;
  try {
    parsedRequest = await readRequest(request);
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Unable to read the ingest request.",
      400,
      "INVALID_INGEST_REQUEST"
    );
  }

  if (!parsedRequest.text) {
    return jsonError("The uploaded document did not contain extractable text.", 422, "EMPTY_TEXT");
  }

  let s3Object: { bucket: string; key: string };
  try {
    s3Object = await uploadToS3({
      body: parsedRequest.body,
      fileName: parsedRequest.fileName,
      mimeType: parsedRequest.mimeType,
      userId,
    });
  } catch (error) {
    return jsonError(
      `S3 upload failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      502,
      "S3_UPLOAD_FAILED"
    );
  }

  let deadlines;
  try {
    deadlines = await extractDeadlines(parsedRequest.text);
  } catch (error) {
    return jsonError(
      `Deadline extraction failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      502,
      "DEADLINE_EXTRACTION_FAILED"
    );
  }

  try {
    const result = await writeMemory({
      userId,
      text: parsedRequest.text,
      sourceType: parsedRequest.sourceType,
      fileName: parsedRequest.fileName,
      mimeType: parsedRequest.mimeType,
      s3Bucket: s3Object.bucket,
      s3Key: s3Object.key,
      deadlines,
    });

    return NextResponse.json(result);
  } catch (error) {
    return jsonError(
      `Memory write failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      500,
      "MEMORY_WRITE_FAILED"
    );
  }
}
