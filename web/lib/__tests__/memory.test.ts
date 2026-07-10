import { describe, expect, it } from "vitest";
import { chunkText } from "../memory";

describe("chunkText", () => {
  it("returns no chunks for empty or whitespace input", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText(" \n\t\n ")).toEqual([]);
  });

  it("returns one chunk for a short single paragraph", () => {
    expect(chunkText("A concise deadline reminder.")).toEqual([
      "A concise deadline reminder.",
    ]);
  });

  it("groups multiple paragraphs around the target size", () => {
    const paragraphs = Array.from(
      { length: 6 },
      (_, index) => `Paragraph ${index + 1} ${"x".repeat(95)}`
    );

    const chunks = chunkText(paragraphs.join("\n\n"), 250, 40);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 250 * 1.5)).toBe(true);
  });

  it("splits a single paragraph longer than one and a half times the target", () => {
    const chunks = chunkText("a".repeat(900), 300, 50);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 300)).toBe(true);
  });

  it("does not emit empty chunks", () => {
    const chunks = chunkText("First paragraph.\n\n\n\nSecond paragraph.", 20, 5);

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((chunk) => chunk.trim().length > 0)).toBe(true);
  });
});
