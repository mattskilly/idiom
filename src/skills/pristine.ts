import { createHash } from "node:crypto";
import { canonicalPath, skillNames } from "./distribution.js";
import { applyWrites, inspect, safeRelative } from "./paths.js";
import type { PristineManifest, SkillName } from "./types.js";

export const pristineRoot = ".agents/skills/.idiom-pristine";
export const manifestPath = `${pristineRoot}/manifest.json`;
export const pristinePath = (key: string) => `${pristineRoot}/${key}`;
export const digest = (content: string) =>
  createHash("sha256").update(content).digest("hex");
export const manifestBytes = (manifest: PristineManifest) =>
  `${JSON.stringify({ schema: 1, files: Object.fromEntries(Object.entries(manifest.files).sort(([a], [b]) => a.localeCompare(b))) }, null, 2)}\n`;
export async function loadPristine(
  root: string,
  snapshots?: Map<string, string>,
): Promise<PristineManifest> {
  const state = await inspect(root, manifestPath, snapshots);
  if (state.kind === "absent") return { schema: 1, files: {} };
  if (state.kind !== "file")
    throw new Error(`Protected pristine manifest: ${manifestPath}`);
  const parsed = JSON.parse(state.content);
  if (
    parsed?.schema !== 1 ||
    !parsed.files ||
    typeof parsed.files !== "object" ||
    Array.isArray(parsed.files) ||
    Object.keys(parsed).some((key) => key !== "schema" && key !== "files")
  )
    throw new Error(
      "Unknown or invalid pristine manifest; preserve it and repair provenance before upgrading",
    );
  for (const [key, record] of Object.entries(parsed.files)) {
    const skill = key.split("/")[0];
    const value = record as Record<string, unknown> | null;
    if (
      !safeRelative(key) ||
      !skillNames.includes(skill as SkillName) ||
      !key.includes("/") ||
      !value ||
      typeof value.version !== "string" ||
      !value.version ||
      typeof value.digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.digest) ||
      Object.keys(value).some(
        (field) => field !== "version" && field !== "digest",
      )
    )
      throw new Error(`Invalid pristine provenance: ${key}`);
  }
  return parsed as PristineManifest;
}
/** Init seeds only bytes it really installed or recognizes exactly. Older
 * provenance is retained unless an explicit verifier replacement was approved. */
export async function seedPristine(
  root: string,
  skill: SkillName,
  files: Record<string, string>,
  version: string,
  replace = false,
): Promise<void> {
  const identity = await inspect(root, `${canonicalPath(skill)}/SKILL.md`);
  if (identity.kind !== "file" || identity.content !== files["SKILL.md"])
    return;
  const manifest = await loadPristine(root);
  for (const [name, content] of Object.entries(files)) {
    const key = `${skill}/${name}`;
    const local = await inspect(root, `${canonicalPath(skill)}/${name}`);
    if (local.kind !== "file" || local.content !== content) continue;
    if (manifest.files[key] && !replace) continue;
    const base = await inspect(root, pristinePath(key));
    if (base.kind !== "file" && base.kind !== "absent") continue;
    // An orphan baseline is evidence too: do not overwrite unknown bytes.
    if (
      !manifest.files[key] &&
      base.kind === "file" &&
      base.content !== content
    )
      continue;
    manifest.files[key] = { version, digest: digest(content) };
    await applyWrites(root, [
      { path: pristinePath(key), content },
      { path: manifestPath, content: manifestBytes(manifest) },
    ]);
  }
}
