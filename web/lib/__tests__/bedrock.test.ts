import { describe, expect, it } from "vitest";
import { normalizeDeadline, parseJsonArray } from "../bedrock";

describe("normalizeDeadline", () => {
  it("returns a normalized deadline for a valid object", () => {
    expect(
      normalizeDeadline({
        title: "Submit renewal",
        due_date: "2026-08-15",
        description: "Renewal package is due.",
        confidence: 0.75,
      })
    ).toEqual({
      title: "Submit renewal",
      due_date: "2026-08-15",
      description: "Renewal package is due.",
      confidence: 0.75,
    });
  });

  it("returns null for a non-ISO date", () => {
    expect(
      normalizeDeadline({
        title: "Submit renewal",
        due_date: "August 15, 2026",
        confidence: 0.75,
      })
    ).toBeNull();
  });

  it("returns null for a missing title", () => {
    expect(
      normalizeDeadline({
        due_date: "2026-08-15",
        confidence: 0.75,
      })
    ).toBeNull();
  });

  it("clamps confidence to the inclusive zero-to-one range", () => {
    expect(
      normalizeDeadline({
        title: "Low confidence",
        due_date: "2026-08-15",
        confidence: -5,
      })?.confidence
    ).toBe(0);
    expect(
      normalizeDeadline({
        title: "High confidence",
        due_date: "2026-08-15",
        confidence: 5,
      })?.confidence
    ).toBe(1);
  });

  it("returns null for non-object garbage", () => {
    expect(normalizeDeadline(null)).toBeNull();
    expect(normalizeDeadline("garbage")).toBeNull();
    expect(normalizeDeadline(42)).toBeNull();
  });
});

describe("parseJsonArray", () => {
  it("parses a clean JSON array", () => {
    expect(parseJsonArray('[{"title":"A"}]')).toEqual([{ title: "A" }]);
  });

  it("parses an array wrapped in json fences and prose", () => {
    expect(
      parseJsonArray('Here are the deadlines:\n```json\n[{"title":"A"}]\n```\nDone.')
    ).toEqual([{ title: "A" }]);
  });

  it("parses an empty array", () => {
    expect(parseJsonArray("[]")).toEqual([]);
  });

  it("throws when no array is present", () => {
    expect(() => parseJsonArray("No deadlines found.")).toThrow(
      "Claude did not return a JSON array."
    );
  });
});
