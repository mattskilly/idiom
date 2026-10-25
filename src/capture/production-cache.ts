import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { z } from "zod";
import { IdiomError } from "../errors.js";

const metadataSchema = z
  .object({
    version: z.literal(1),
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
    port: z.number().int().min(1).max(65535),
    id: z.string().min(1),
  })
  .strict();
export type CacheMetadata = z.infer<typeof metadataSchema>;
export const inputHash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Check every ancestor, including managed directories, before creating paths. */
export async function assertContainedPath(
  root: string,
  path: string,
): Promise<void> {
  const child = relative(root, path);
  if (!child || child === ".." || child.startsWith(`..${sep}`))
    throw new IdiomError(
      "production cache path must remain inside the project",
    );
  let current = path;
  while (current !== root) {
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new IdiomError(
          "production cache paths must not traverse symlinks",
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    current = dirname(current);
  }
}

export async function openProductionCache(root: string, output: string) {
  const base = join(root, ".idiom", "cache", "production");
  await assertContainedPath(root, base);
  await mkdir(base, { recursive: true });
  await assertContainedPath(root, join(base, ".gitignore"));
  await writeFile(join(base, ".gitignore"), "*\n");
  const directory = join(base, inputHash([root, output]));
  await assertContainedPath(root, directory);
  await mkdir(directory, { recursive: true });
  const lock = join(directory, "lock");
  try {
    await mkdir(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new IdiomError(
        `production output is owned by another capture; retry after it finishes (lock: ${lock})`,
      );
    throw error;
  }
  const entry = join(directory, "entry");
  const dataDirectory = join(directory, "data");
  let metadata: CacheMetadata | undefined;
  try {
    await assertContainedPath(root, join(entry, "output"));
    await assertContainedPath(root, join(entry, "metadata.json"));
    metadata = metadataSchema.parse(
      JSON.parse(await readFile(join(entry, "metadata.json"), "utf8")),
    );
  } catch {
    /* Missing or malformed entries are cache misses. */
  }
  return {
    metadata,
    dataDirectory,
    resetData: async () => {
      await assertContainedPath(root, dataDirectory);
      await rm(dataDirectory, { recursive: true, force: true });
      await mkdir(dataDirectory);
    },
    restore: async (hash: string, fallbackId: string) => {
      if (!metadata || metadata.inputHash !== hash) return false;
      try {
        await assertContainedPath(root, join(entry, "output"));
        const stat = await lstat(join(entry, "output"));
        if (!stat.isDirectory()) return false;
        const id = await readBuildId(join(entry, "output"), fallbackId);
        if (id !== metadata.id) return false;
        await cp(join(entry, "output"), output, {
          recursive: true,
          dereference: false,
        });
        return true;
      } catch {
        await rm(output, { recursive: true, force: true });
        return false;
      }
    },
    promote: async (value: CacheMetadata, signal?: AbortSignal) => {
      const staging = join(directory, `staging-${randomUUID()}`);
      try {
        await mkdir(staging);
        await cp(output, join(staging, "output"), {
          recursive: true,
          dereference: false,
        });
        await writeFile(
          join(staging, "metadata.json"),
          `${JSON.stringify(value)}\n`,
        );
        signal?.throwIfAborted();
        await rm(entry, { recursive: true, force: true });
        signal?.throwIfAborted();
        await rename(staging, entry);
        if (signal?.aborted) {
          await rm(entry, { recursive: true, force: true });
          signal.throwIfAborted();
        }
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    },
    close: async () => {
      await rm(dataDirectory, { recursive: true, force: true });
      await rm(lock, { recursive: true, force: true });
    },
  };
}
export async function readBuildId(
  output: string,
  fallback: string,
): Promise<string> {
  try {
    return (
      (await readFile(join(output, "BUILD_ID"), "utf8")).trim() || fallback
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return fallback;
  }
}
