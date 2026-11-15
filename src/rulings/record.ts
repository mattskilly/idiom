import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { IdiomError } from "../errors.js";
import { atomicWrite } from "../learn/write.js";
import type { RulingResolution } from "../schemas/ruling.js";
import { appendRuling, rulingDiff } from "./law.js";

export type RulingConfirmation = (diff: string) => Promise<boolean>;

/** A further file the ruling writes in the same confirmed diff. */
export type RulingExtraWrite = {
  path: string;
  /** The text shown in the diff. */
  diff: string;
  after: string;
};

export async function recordRuling(options: {
  designPath: string;
  displayPath: string;
  resolution: RulingResolution;
  confirm: RulingConfirmation;
  write?: ((message: string) => void) | undefined;
  /** Shown above the diff (for example, the check a law compiles to). */
  preface?: string | undefined;
  /** Written after the ruling, only when the human confirms. */
  extraWrites?: RulingExtraWrite[] | undefined;
}): Promise<{
  recorded: boolean;
  path: string;
  resolution?: RulingResolution;
}> {
  const source = await readFile(options.designPath, "utf8");
  const completed = appendRuling(source, options.resolution);
  const diff = [
    ...(options.preface === undefined ? [] : [`${options.preface}\n`]),
    rulingDiff(options.displayPath, source, completed),
    ...(options.extraWrites ?? []).map((write) => write.diff),
  ].join("\n");
  options.write?.(diff);
  if (!(await options.confirm(diff)))
    return { recorded: false, path: options.designPath };

  await mkdir(join(options.designPath, ".."), { recursive: true });
  const temporary = `${options.designPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporary, completed, "utf8");
    await rename(temporary, options.designPath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw new IdiomError(
      `cannot record ruling in ${options.designPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  for (const write of options.extraWrites ?? [])
    await atomicWrite(write.path, write.after);
  return {
    recorded: true,
    path: options.designPath,
    resolution: options.resolution,
  };
}
