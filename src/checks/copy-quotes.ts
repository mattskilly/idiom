/** Balanced ranges, including delimiters. Self-contained for browser installation. */
export function copyQuoteRanges(
  text: string,
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const stack: Array<{ start: number; close: string }> = [];
  const pairs: Record<string, string> = {
    '"': '"',
    "'": "'",
    "“": "”",
    "‘": "’",
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index] ?? "";
    if (!"\"'“”‘’".includes(char)) continue;
    let escapes = 0;
    for (let before = index - 1; before >= 0 && text[before] === "\\"; before--)
      escapes++;
    if (escapes % 2 === 1) continue;
    // Possessives and contractions are punctuation within words, not delimiters.
    if (
      (char === "'" || char === "’") &&
      /[\p{L}\p{N}]/u.test(text[index - 1] ?? "") &&
      /[\p{L}\p{N}]/u.test(text[index + 1] ?? "")
    )
      continue;
    const top = stack.at(-1);
    if (top?.close === char) {
      stack.pop();
      ranges.push({ start: top.start, end: index + 1 });
    } else if (pairs[char] !== undefined) {
      // A trailing possessive (users') cannot start a quotation.
      if (char === "'" && /[\p{L}\p{N}]/u.test(text[index - 1] ?? "")) continue;
      stack.push({ start: index, close: pairs[char] ?? char });
    }
  }
  return ranges.sort((a, b) => a.start - b.start || b.end - a.end);
}

/** Legacy local-text fallback; never joins text after removing a quote. */
export function copyQuoteSegments(
  text: string,
): Array<{ text: string; quoted: boolean }> {
  const ranges = copyQuoteRanges(text);
  const boundaries = [
    ...new Set([
      0,
      text.length,
      ...ranges.flatMap(({ start, end }) => [start, end]),
    ]),
  ].sort((a, b) => a - b);
  return boundaries.slice(0, -1).map((start, index) => ({
    text: text.slice(start, boundaries[index + 1]),
    quoted: ranges.some((range) => start >= range.start && start < range.end),
  }));
}
