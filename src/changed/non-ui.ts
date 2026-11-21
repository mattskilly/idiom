import { globRegex } from "../../plugins/claude/hooks/lib.mjs";

/**
 * The one path classifier `check --changed` and the build gate share. It
 * lives beside the change selection so the gate imports it from here, never
 * the other way round.
 */
export type FileClass = {
  path: string;
  ui: boolean;
  /** Why the gate called the file non-UI or UI. */
  reason: string;
};

/** Changed paths that never reach a rendered page. */
const nonUiPatterns: Array<[RegExp, string]> = [
  [/\.md$/i, "documentation"],
  [/^docs\//, "documentation"],
  [/(?:^|\/)(?:test|tests|__tests__)\//, "tests"],
  [/\.(?:test|spec)\.[^/]+$/, "tests"],
  [/^\.github\//, "CI configuration"],
  [/^\.ab\//, "build scratch"],
  [/^\.autobuild\//, "build scratch"],
  [
    /(?:^|\/)(?:[^/]+\.lock|bun\.lockb?|package-lock\.json|pnpm-lock\.yaml)$/,
    "lockfile",
  ],
  [/(?:^|\/)\.idiom\/(?:reports|cache)\//, "Idiom run output"],
];

/**
 * Pattern pass: no import graph, so a docs-only change exits in milliseconds.
 * Only the checked project's own design context (repo-relative `repoPath`,
 * falling back to `path`) counts as UI; a DESIGN.md or PRODUCT.md elsewhere
 * is ordinary documentation.
 */
export function classifyByPath(
  files: Array<{ path: string; repoPath?: string | undefined }>,
  nonUi: string[] = [],
  designContext: string[] = ["DESIGN.md", "PRODUCT.md"],
): FileClass[] {
  const globs = nonUi.map((glob) => [glob, globRegex(glob)] as const);
  return files.map(({ path, repoPath }) => {
    const normalized = path.replaceAll("\\", "/");
    if (designContext.includes((repoPath ?? path).replaceAll("\\", "/")))
      return { path, ui: true, reason: "design context" };
    for (const [pattern, reason] of nonUiPatterns)
      if (pattern.test(normalized)) return { path, ui: false, reason };
    const glob = globs.find(([, regex]) => regex.test(normalized));
    if (glob)
      return { path, ui: false, reason: `checks.gate.nonUi ${glob[0]}` };
    return { path, ui: true, reason: "may affect the UI" };
  });
}
