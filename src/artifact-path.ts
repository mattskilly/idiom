import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { IdiomError } from "./errors.js";

function inside(root: string, target: string) {
  const path = relative(root, target);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

/** Evidence must be declared by a validated finding and stay within its owning run. */
export async function evidencePath(
  runDirectory: string,
  path: string,
): Promise<string> {
  if (
    isAbsolute(path) ||
    /\\|\0/.test(path) ||
    !inside(runDirectory, resolve(runDirectory, path))
  )
    throw new IdiomError(
      `Evidence path escapes its source run: ${path}. Obtain a fresh check.`,
    );
  const [root, target] = await Promise.all([
    realpath(runDirectory),
    realpath(resolve(runDirectory, path)),
  ]);
  if (!inside(root, target))
    throw new IdiomError(
      `Evidence symlink escapes its source run: ${path}. Obtain a fresh check.`,
    );
  return target;
}
