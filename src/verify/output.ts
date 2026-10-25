import { access, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { IdiomError } from "../errors.js";

/** Which command owns an output directory, and how it says so. */
export type OutputOwner = {
  /** The command name used in errors (`verify`, `compare`). */
  command: string;
  marker: string;
  text: string;
};

export const verifyOutputOwner: OutputOwner = {
  command: "verify",
  marker: ".idiom-verify-output",
  text: "This directory is owned by idiom verify.\n",
};

export const compareOutputOwner: OutputOwner = {
  command: "compare",
  marker: ".idiom-compare-output",
  text: "This directory is owned by idiom compare.\n",
};

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function assertReplaceable(
  outputDirectory: string,
  owner: OutputOwner,
): Promise<void> {
  if (!(await exists(outputDirectory))) return;
  const details = await stat(outputDirectory);
  if (!details.isDirectory())
    throw new IdiomError(
      `${owner.command} output exists and is not a directory: ${outputDirectory}`,
    );
  try {
    const [manifestSource, marker] = await Promise.all([
      readFile(join(outputDirectory, "attachments.json"), "utf8"),
      readFile(join(outputDirectory, owner.marker), "utf8"),
    ]);
    const manifest = JSON.parse(manifestSource) as {
      version?: unknown;
      report?: { kind?: unknown };
    };
    if (
      manifest.version !== 1 ||
      manifest.report?.kind !== "idiom-verify-report" ||
      marker !== owner.text
    )
      throw new Error(`not ${owner.command}-owned`);
  } catch {
    throw new IdiomError(
      `refusing to replace output without a valid Idiom ${owner.command} ownership marker: ${outputDirectory}`,
    );
  }
}

export async function publish(
  staging: string,
  output: string,
  owner: OutputOwner,
): Promise<void> {
  await assertReplaceable(output, owner);
  await mkdir(dirname(output), { recursive: true });
  if (!(await exists(output))) {
    await rename(staging, output);
    return;
  }
  const backup = `${output}.previous-${process.pid}`;
  await rm(backup, { recursive: true, force: true });
  await rename(output, backup);
  try {
    await rename(staging, output);
    await rm(backup, { recursive: true, force: true });
  } catch (error) {
    await rename(backup, output).catch(() => undefined);
    throw error;
  }
}
