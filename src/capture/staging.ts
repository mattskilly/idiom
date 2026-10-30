import { basename } from "node:path";

/** Name prefix of the sibling directory a capture stages into before publishing. */
export function stagingDirectoryPrefix(finalDirectory: string): string {
  return `.${basename(finalDirectory)}.staging-`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether `name` is a staging sibling created for `finalDirectory`. */
export function isStagingDirectoryName(
  finalDirectory: string,
  name: string,
): boolean {
  // mkdtemp appends exactly six characters from [A-Za-z0-9].
  return new RegExp(
    `^${escapeRegExp(stagingDirectoryPrefix(finalDirectory))}[A-Za-z0-9]{6}$`,
  ).test(name);
}
