import { readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { ReferenceRef } from "./types.js";

const imageTypes: Record<
  string,
  Extract<ReferenceRef, { kind: "image" }>["mediaType"]
> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * A reference loaded from a file relative to `cwd`: an image reference for
 * image files, otherwise the file's text. Undefined when `value` names no file.
 */
export async function referenceFromFile(options: {
  cwd: string;
  value: string;
  label: string;
  polarity: "reference" | "anti-reference";
}): Promise<ReferenceRef | undefined> {
  const { label, polarity, value } = options;
  const path = resolve(options.cwd, value);
  if (!(await isFile(path))) return undefined;
  const mediaType = imageTypes[extname(path).toLowerCase()];
  return mediaType === undefined
    ? { label, polarity, kind: "text", content: await readFile(path, "utf8") }
    : {
        label,
        polarity,
        kind: "image",
        readPath: path,
        mediaType,
        sourceKind: "file",
        source: value,
      };
}
