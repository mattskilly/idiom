import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Source } from "./types.js";

export const excludedDirectories = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".output",
  "coverage",
  ".idiom",
  ".ab",
  ".autobuild",
]);
/** Cheap detection only: never imports or evaluates application modules. */
export async function discoverSources(root: string): Promise<Source[]> {
  const sources: Source[] = [];
  const visit = async (directory: string, prefix: string) => {
    for (const entry of (
      await readdir(directory, { withFileTypes: true })
    ).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name))
          await visit(join(directory, entry.name), path);
      } else if (entry.isFile()) {
        if (/^tailwind\.config\.(?:[cm]?[jt]s)$/.test(entry.name))
          sources.push({ path, kind: "tailwind" });
        else if (entry.name.endsWith(".css")) {
          const text = await readFile(join(root, path), "utf8");
          if (
            /(?:@theme\b|:root\b|\[data-theme[^\]]*\])/.test(text) &&
            /--[\w*-]+\s*:/.test(text)
          )
            sources.push({ path, kind: "css" });
        } else if (entry.name.endsWith(".json")) {
          const text = await readFile(join(root, path), "utf8");
          if (
            /"\$value"\s*:/.test(text) ||
            /(?:^|\.)tokens\.json$/.test(entry.name)
          )
            sources.push({ path, kind: "dtcg" });
        }
      }
    }
  };
  await visit(root, "");
  return sources.sort((a, b) => a.path.localeCompare(b.path));
}
