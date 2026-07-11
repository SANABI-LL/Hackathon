import { NextResponse } from "next/server";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createHash, randomUUID } from "crypto";
import {
  extractDeadlines,
  extractFromMedia,
  type ExtractedDeadline,
  type SupportedMediaType,
} from "@/lib/bedrock";
import { writeMemory } from "@/lib/memory";

export const maxDuration = 60;
export const runtime = "nodejs";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MIN_TEXT_PDF_CHARS = 120;
const SUPPORTED_MEDIA_TYPES = new Set<string>([
  "application/pdf",
  "image/png",
  "image/jpeg",
]);

interface IngestPayload {
  text?: unknown;
}

class FileTooLargeError extends Error {
  constructor() {
    super(`Upload size must be ${MAX_UPLOAD_BYTES / 1024 / 1024} MB or less.`);
  }
}

class MultimodalExtractionError extends Error {
  constructor(message: string) {
    super(message);
  }
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

function assertUploadSize(size: number): void {
  if (size > MAX_UPLOAD_BYTES) {
    throw new FileTooLargeError();
  }
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  // Lazy import: pdf-parse pulls in pdfjs-dist, which needs DOM polyfills
  // (@napi-rs/canvas) at module init — must not run for text-only ingests.
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: buffer });

  try {
    const result = await parser.getText();
    return result.text.trim();
  } finally {
    await parser.destroy();
  }
}

function isSupportedMediaType(mimeType: string): mimeType is SupportedMediaType {
  return SUPPORTED_MEDIA_TYPES.has(mimeType);
}

function inferMimeType(file: File): string {
  const name = file.name.toLowerCase();
  if (file.type) return file.type;
  if (name.endsWith(".pdf")) return "application/pdf";
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".txt")) return "text/plain";
  return "application/octet-stream";
}

async function extractUploadContent(
  body: Buffer,
  mimeType: string
): Promise<{
  text: string;
  sourceType: "pdf" | "text" | "image";
  deadlines: ExtractedDeadline[] | null;
}> {
  if (mimeType === "application/pdf") {
    const pdfText = await extractPdfText(body);
    if (pdfText.length >= MIN_TEXT_PDF_CHARS) {
      return { text: pdfText, sourceType: "pdf", deadlines: null };
    }

    let mediaResult;
    try {
      mediaResult = await extractFromMedia(body.toString("base64"), "application/pdf");
    } catch (error) {
      throw new MultimodalExtractionError(
        error instanceof Error ? error.message : "Multimodal PDF extraction failed."
      );
    }
    return {
      text: mediaResult.transcript,
      sourceType: "pdf",
      deadlines: mediaResult.deadlines,
    };
  }

  if (mimeType === "image/png" || mimeType === "image/jpeg") {
    let mediaResult;
    try {
      mediaResult = await extractFromMedia(body.toString("base64"), mimeType);
    } catch (error) {
      throw new MultimodalExtractionError(
        error instanceof Error ? error.message : "Multimodal image extraction failed."
      );
    }
    return {
      text: mediaResult.transcript,
      sourceType: "image",
      deadlines: mediaResult.deadlines,
    };
  }

  return { text: body.toString("utf8").trim(), sourceType: "text", deadlines: null };
}

async function readRequest(request: Request): Promise<{
  body: Buffer;
  text: string;
  sourceType: "pdf" | "text" | "image";
  fileName: string | null;
  mimeType: string | null;
  deadlines: ExtractedDeadline[] | null;
}> {
  const contentType = request.headers.get("content-type") || "";

  if (contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
    const file = formData.get("file");
    const textField = formData.get("text");

    if (file instanceof File) {
      assertUploadSize(file.size);
      const arrayBuffer = await file.arrayBuffer();
      const body = Buffer.from(arrayBuffer);
      assertUploadSize(body.length);
      const mimeType = inferMimeType(file);
      if (mimeType !== "text/plain" && !isSupportedMediaType(mimeType)) {
        throw new Error("Upload a PDF, PNG, JPEG, plain text file, or paste text.");
      }
      const extracted = await extractUploadContent(body, mimeType);

      return {
        body,
        text: extracted.text,
        sourceType: extracted.sourceType,
        fileName: file.name || "upload",
        mimeType,
        deadlines: extracted.deadlines,
      };
    }

    if (typeof textField === "string" && textField.trim()) {
      const text = textField.trim();
      const body = Buffer.from(text, "utf8");
      assertUploadSize(body.length);
      return {
        body,
        text,
        sourceType: "text",
        fileName: "pasted-text.txt",
        mimeType: "text/plain",
        deadlines: null,
      };
    }
  }

  if (contentType.includes("application/json")) {
    const rawBody = await request.text();
    assertUploadSize(Buffer.byteLength(rawBody, "utf8"));
    const payload = JSON.parse(rawBody) as IngestPayload;
    if (typeof payload.text === "string" && payload.text.trim()) {
      const text = payload.text.trim();
      const body = Buffer.from(text, "utf8");
      assertUploadSize(body.length);
      return {
        body,
        text,
        sourceType: "text",
        fileName: "pasted-text.txt",
        mimeType: "text/plain",
        deadlines: null,
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
  const contentLength = request.headers.get("content-length");
  if (contentLength) {
    const size = Number(contentLength);
    if (Number.isFinite(size) && size > MAX_UPLOAD_BYTES) {
      return jsonError(
        `Upload size must be ${MAX_UPLOAD_BYTES / 1024 / 1024} MB or less.`,
        413,
        "FILE_TOO_LARGE"
      );
    }
  }

  let parsedRequest: Awaited<ReturnType<typeof readRequest>>;
  try {
    parsedRequest = await readRequest(request);
  } catch (error) {
    if (error instanceof FileTooLargeError) {
      return jsonError(error.message, 413, "FILE_TOO_LARGE");
    }
    if (error instanceof MultimodalExtractionError) {
      return jsonError(error.message, 502, "MULTIMODAL_EXTRACTION_FAILED");
    }

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
    deadlines = parsedRequest.deadlines ?? (await extractDeadlines(parsedRequest.text));
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
