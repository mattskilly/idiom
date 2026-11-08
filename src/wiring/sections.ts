export const newlineOf = (text: string): string =>
  text.includes("\r\n") ? "\r\n" : "\n";
export function markers(
  name: string,
  format: "html" | "hash" = "hash",
): [string, string] {
  return format === "html"
    ? [
        `<!-- idiom:wiring:${name}:begin -->`,
        `<!-- idiom:wiring:${name}:end -->`,
      ]
    : [`# idiom:wiring:${name}:begin`, `# idiom:wiring:${name}:end`];
}
export function sectionSpan(
  source: string,
  pair: [string, string],
): { start: number; end: number } | undefined {
  const [begin, end] = pair;
  const start = source.indexOf(begin);
  const finish = source.indexOf(end);
  if (start === -1 && finish === -1) return undefined;
  if (
    start === -1 ||
    finish < start ||
    source.indexOf(begin, start + begin.length) !== -1 ||
    source.indexOf(end, finish + end.length) !== -1
  )
    throw new Error(`Malformed or duplicate markers: ${begin}`);
  const lineStart = source.lastIndexOf("\n", start - 1) + 1;
  if (
    source.slice(lineStart, start).trim() ||
    !/^(?:\r?\n|$)/.test(source.slice(finish + end.length))
  )
    throw new Error(`Markers must occupy their own lines: ${begin}`);
  return { start: lineStart, end: finish + end.length };
}
export function markedBlock(
  name: string,
  body: string,
  newline = "\n",
  format: "html" | "hash" = "hash",
): string {
  const [begin, end] = markers(name, format);
  return [
    begin,
    body.replace(/\r?\n/g, newline).replace(/(?:\r?\n)+$/, ""),
    end,
  ].join(newline);
}
export function replaceSection(
  source: string,
  name: string,
  body: string,
  options: { format?: "html" | "hash"; reserved?: boolean } = {},
): string {
  const newline = newlineOf(source);
  const span = sectionSpan(source, markers(name, options.format));
  const block = markedBlock(name, body, newline, options.format);
  if (span) return source.slice(0, span.start) + block + source.slice(span.end);
  if (options.reserved && source.length)
    throw new Error(
      "Unmarked reserved destination; move it aside or add the integration manually",
    );
  return (
    source +
    (source.length && !source.endsWith("\n") ? newline : "") +
    block +
    newline
  );
}
