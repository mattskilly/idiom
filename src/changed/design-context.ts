import { realpath } from "node:fs/promises";
import { posix, relative, sep } from "node:path";

/**
 * The project's design context: the one definition `check --changed`, the
 * build gate and the base comparison share. Only these files, resolved from
 * the checked project's directory, are the project's design; a DESIGN.md
 * anywhere else (a fixture, a template, another package) is documentation.
 */
export type DesignContext = { designFile: string; productFile: string };

export const defaultDesignContext: DesignContext = {
  designFile: "DESIGN.md",
  productFile: "PRODUCT.md",
};

/**
 * The project directory relative to the repository, `/`-separated, `""` at
 * the root. Both sides are realpathed: git reports the repository's real
 * path, and a symlinked project directory (a macOS tmpdir under /var) would
 * otherwise give a `../` prefix.
 */
export async function projectPrefix(
  repository: string,
  projectDirectory: string,
): Promise<string> {
  const [root, project] = await Promise.all([
    realpath(repository).catch(() => repository),
    realpath(projectDirectory).catch(() => projectDirectory),
  ]);
  return relative(root, project).split(sep).join("/");
}

/**
 * The project's own design context as REPO-relative paths. Never localized:
 * under --project a repo-root DESIGN.md and the project's own would collide.
 * A path outside the repository (`../…`) matches no changed file.
 */
export function designContextPaths(
  design: DesignContext,
  prefix: string,
): { design: string; product: string } {
  const resolve = (file: string) => {
    const normalized = file.replaceAll("\\", "/");
    return posix.normalize(prefix ? `${prefix}/${normalized}` : normalized);
  };
  return {
    design: resolve(design.designFile),
    product: resolve(design.productFile),
  };
}
