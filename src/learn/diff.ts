const CONTEXT = 3;

function lines(source: string): string[] {
  const split = source.replace(/\r\n/g, "\n").split("\n");
  if (split.at(-1) === "") split.pop();
  return split;
}

/**
 * A one-hunk unified diff between two versions of a text file: the common
 * prefix and suffix are context, everything between them changed. Exact for
 * the appends and single-region edits learn makes; `before` undefined is a
 * new file.
 */
export function fileDiff(
  displayPath: string,
  before: string | undefined,
  after: string,
): string {
  const old = before === undefined ? [] : lines(before);
  const next = lines(after);
  let prefix = 0;
  while (
    prefix < old.length &&
    prefix < next.length &&
    old[prefix] === next[prefix]
  )
    prefix += 1;
  let suffix = 0;
  while (
    suffix < old.length - prefix &&
    suffix < next.length - prefix &&
    old[old.length - 1 - suffix] === next[next.length - 1 - suffix]
  )
    suffix += 1;
  const start = Math.max(0, prefix - CONTEXT);
  const oldEnd = Math.min(old.length, old.length - suffix + CONTEXT);
  const newEnd = Math.min(next.length, next.length - suffix + CONTEXT);
  const removed = old.slice(prefix, old.length - suffix);
  const added = next.slice(prefix, next.length - suffix);
  const oldCount = oldEnd - start;
  const newCount = newEnd - start;
  const range = (from: number, count: number) =>
    `${count === 0 ? from : from + 1},${count}`;
  return [
    before === undefined ? "--- /dev/null" : `--- a/${displayPath}`,
    `+++ b/${displayPath}`,
    `@@ -${range(start, oldCount)} +${range(start, newCount)} @@`,
    ...old.slice(start, prefix).map((line) => ` ${line}`),
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
    ...next.slice(next.length - suffix, newEnd).map((line) => ` ${line}`),
    "",
  ].join("\n");
}
