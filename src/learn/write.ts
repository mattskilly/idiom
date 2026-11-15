import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { IdiomError } from "../errors.js";

/** Write a file through a temporary sibling so readers never see half of it. */
export async function atomicWrite(
  path: string,
  content: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporary, content, "utf8");
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw new IdiomError(
      `cannot write ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
