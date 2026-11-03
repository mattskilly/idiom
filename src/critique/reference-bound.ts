import type { ReferenceRef } from "./types.js";

/**
 * Per-reference character cap for text references and anti-references in
 * every model batch prompt. Each batch repeats the references, so an
 * unbounded file would multiply toward the provider request limit.
 */
export const TEXT_REFERENCE_LIMIT = 12_000;

export type BoundedTextReference = {
  content: string;
  truncated: boolean;
  totalChars: number;
  includedChars: number;
};

export type TruncatedReference = {
  label: string;
  polarity: "reference" | "anti-reference";
  totalChars: number;
  includedChars: number;
};

export function boundTextReference(content: string): BoundedTextReference {
  if (content.length <= TEXT_REFERENCE_LIMIT) {
    return {
      content,
      truncated: false,
      totalChars: content.length,
      includedChars: content.length,
    };
  }
  let end = TEXT_REFERENCE_LIMIT;
  const last = content.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return {
    content: content.slice(0, end),
    truncated: true,
    totalChars: content.length,
    includedChars: end,
  };
}

export function truncatedTextReferences(
  references: ReferenceRef[],
): TruncatedReference[] {
  return references.flatMap((reference) => {
    if (reference.kind !== "text") return [];
    const bounded = boundTextReference(reference.content);
    return bounded.truncated
      ? [
          {
            label: reference.label,
            polarity: reference.polarity,
            totalChars: bounded.totalChars,
            includedChars: bounded.includedChars,
          },
        ]
      : [];
  });
}

function count(value: number): string {
  return value.toLocaleString("en-US");
}

export function truncatedReferencesSentence(
  items: TruncatedReference[],
): string {
  return `Text references truncated for the model (limit ${count(TEXT_REFERENCE_LIMIT)} characters each): ${items
    .map(
      (item) =>
        `${item.label} (${count(item.totalChars)} characters, first ${count(item.includedChars)} sent)`,
    )
    .join(", ")}.`;
}
