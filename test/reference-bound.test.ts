import { describe, expect, test } from "vitest";
import {
  boundTextReference,
  TEXT_REFERENCE_LIMIT,
  truncatedReferencesSentence,
  truncatedTextReferences,
} from "../src/critique/reference-bound.js";

describe("text reference bound", () => {
  test("content at or below the limit is returned unchanged", () => {
    for (const content of ["short", "x".repeat(TEXT_REFERENCE_LIMIT)])
      expect(boundTextReference(content)).toEqual({
        content,
        truncated: false,
        totalChars: content.length,
        includedChars: content.length,
      });
  });

  test("oversized content is cut to the limit", () => {
    const content = "x".repeat(TEXT_REFERENCE_LIMIT + 5000);
    const bounded = boundTextReference(content);
    expect(bounded.truncated).toBe(true);
    expect(bounded.content).toHaveLength(TEXT_REFERENCE_LIMIT);
    expect(bounded.totalChars).toBe(TEXT_REFERENCE_LIMIT + 5000);
    expect(bounded.includedChars).toBe(TEXT_REFERENCE_LIMIT);
  });

  test("a surrogate pair straddling the boundary is not split", () => {
    const content = `${"x".repeat(TEXT_REFERENCE_LIMIT - 1)}😀tail`;
    const bounded = boundTextReference(content);
    expect(bounded.includedChars).toBe(TEXT_REFERENCE_LIMIT - 1);
    expect(bounded.content).toBe("x".repeat(TEXT_REFERENCE_LIMIT - 1));
  });

  test("only oversized text references are listed, with label and polarity", () => {
    const big = "y".repeat(TEXT_REFERENCE_LIMIT + 1);
    expect(
      truncatedTextReferences([
        {
          label: "reference:hero.png",
          polarity: "reference",
          kind: "image",
          readPath: "/tmp/hero.png",
          mediaType: "image/png",
        },
        {
          label: "reference:small.md",
          polarity: "reference",
          kind: "text",
          content: "small",
        },
        {
          label: "anti-reference:big.md",
          polarity: "anti-reference",
          kind: "text",
          content: big,
        },
      ]),
    ).toEqual([
      {
        label: "anti-reference:big.md",
        polarity: "anti-reference",
        totalChars: TEXT_REFERENCE_LIMIT + 1,
        includedChars: TEXT_REFERENCE_LIMIT,
      },
    ]);
  });

  test("the report sentence names each reference with both lengths", () => {
    expect(
      truncatedReferencesSentence([
        {
          label: "reference:brand.md",
          polarity: "reference",
          totalChars: 40_213,
          includedChars: 12_000,
        },
        {
          label: "anti-reference:old.md",
          polarity: "anti-reference",
          totalChars: 13_000,
          includedChars: 11_999,
        },
      ]),
    ).toBe(
      "Text references truncated for the model (limit 12,000 characters each): reference:brand.md (40,213 characters, first 12,000 sent), anti-reference:old.md (13,000 characters, first 11,999 sent).",
    );
  });
});
