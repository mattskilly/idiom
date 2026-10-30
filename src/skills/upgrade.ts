import { mkdir, rm, rmdir, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sanitizeCritiqueDiagnostic } from "../critique/claude-code.js";
import {
  canonicalPath,
  discoveryPath,
  discoveryTarget,
  type History,
  readDistribution,
  readHistory,
  skillNames,
} from "./distribution.js";
import {
  type MergeRunner,
  mergeText,
  reconstruct,
  skillIdentity,
  validateFile,
} from "./merge.js";
import {
  type ApplyDependencies,
  applyWrites,
  inspect,
  unchanged,
  type Write,
} from "./paths.js";
import {
  digest,
  loadPristine,
  manifestBytes,
  manifestPath,
  pristinePath,
} from "./pristine.js";
import {
  createResolver,
  type Resolver,
  type ResolverDependencies,
} from "./resolver.js";
import type {
  Distribution,
  FileOutcome,
  PreviousVersion,
  PristineManifest,
  SkillName,
  UpgradeReport,
} from "./types.js";

export type UpgradeDependencies = {
  distribution?: Distribution;
  history?: History;
  mergeRunner?: MergeRunner;
  createResolver?: () => Resolver;
  resolver?: ResolverDependencies;
  apply?: ApplyDependencies;
};
type Decision = {
  outcome: FileOutcome;
  key: string;
  content?: string;
  baseline?: string;
  retire?: boolean;
  protected?: boolean;
  snapshots: Map<string, string>;
};
const unknown: PreviousVersion = { kind: "unknown" };
function versions(values: string[]): PreviousVersion {
  const unique = [...new Set(values)].sort();
  return unique.length === 1
    ? { kind: "known", version: unique[0] as string }
    : unique.length
      ? { kind: "candidates", versions: unique }
      : unknown;
}
function previousSummary(files: FileOutcome[]): UpgradeReport["previous"] {
  const values = [
    ...new Map(
      files.map((file) => [JSON.stringify(file.previous), file.previous]),
    ).values(),
  ];
  return values.length === 1
    ? (values[0] as PreviousVersion)
    : values.length
      ? { kind: "mixed", versions: values }
      : unknown;
}
export async function upgradeSkills(
  options: {
    projectDirectory: string;
    dryRun?: boolean | undefined;
    agent?: boolean | undefined;
  },
  dependencies: UpgradeDependencies = {},
): Promise<UpgradeReport> {
  const root = options.projectDirectory;
  const distribution = dependencies.distribution ?? (await readDistribution());
  const history = dependencies.history ?? (await readHistory());
  const manifestSnapshot = new Map<string, string>();
  let manifest: PristineManifest = { schema: 1, files: {} };
  let manifestError: string | undefined;
  try {
    manifest = await loadPristine(root, manifestSnapshot);
  } catch (error) {
    manifestError = sanitizeCritiqueDiagnostic(error);
  }
  const report: UpgradeReport = {
    projectDirectory: root,
    installedVersion: distribution.version,
    previous: unknown,
    dryRun: options.dryRun === true,
    files: [],
    discoveryConflicts: [],
  };
  const decisions: Decision[] = [];
  const links = new Map<
    SkillName,
    { snapshots: Map<string, string>; missing: boolean }
  >();
  let resolver: Resolver | undefined;
  for (const skill of skillNames) {
    const incomingFiles = distribution.skills[skill] ?? {};
    const tracked = Object.keys(manifest.files).filter((key) =>
      key.startsWith(`${skill}/`),
    );
    const skillSnapshots = new Map<string, string>();
    let protectedReason: string | undefined;
    let canonicalAbsent = false;
    let identity: string | undefined;
    try {
      const directory = await inspect(
        root,
        canonicalPath(skill),
        skillSnapshots,
      );
      canonicalAbsent = directory.kind === "absent";
      if (skill === "ab-verify-idiom" && canonicalAbsent && !tracked.length)
        continue;
      if (directory.kind !== "absent" && directory.kind !== "directory")
        protectedReason = "Canonical skill path is a protected entry";
      else {
        const main = await inspect(
          root,
          `${canonicalPath(skill)}/SKILL.md`,
          skillSnapshots,
        );
        if (main.kind === "file") {
          identity = skillIdentity(main.content);
          if (identity !== skill)
            protectedReason = "Different or invalid skill frontmatter identity";
        } else if (
          main.kind !== "absent" ||
          (!canonicalAbsent && !tracked.length)
        )
          protectedReason =
            "Canonical directory is unowned or SKILL.md is protected";
      }
    } catch (error) {
      protectedReason = sanitizeCritiqueDiagnostic(error);
    }
    try {
      const snapshots = new Map<string, string>();
      const discovery = await inspect(root, discoveryPath(skill), snapshots);
      if (
        discovery.kind !== "absent" &&
        !(
          discovery.kind === "symlink" &&
          discovery.target === discoveryTarget(skill)
        )
      )
        throw new Error(
          "Protected discovery entry; move it manually to enable the Idiom discovery link",
        );
      links.set(skill, { snapshots, missing: discovery.kind === "absent" });
    } catch (error) {
      report.discoveryConflicts.push({
        path: discoveryPath(skill),
        reason: sanitizeCritiqueDiagnostic(error),
      });
    }
    const names = [
      ...new Set([
        ...Object.keys(incomingFiles),
        ...tracked.map((key) => key.slice(skill.length + 1)),
      ]),
    ].sort();
    for (const name of names) {
      const key = `${skill}/${name}`;
      const incoming = Object.hasOwn(incomingFiles, name)
        ? incomingFiles[name]
        : undefined;
      const provenance = manifest.files[key];
      const outcome: FileOutcome = {
        skill,
        path: `${canonicalPath(skill)}/${name}`,
        action: "current",
        previous: provenance
          ? { kind: "known", version: provenance.version }
          : unknown,
        incomingVersion: distribution.version,
        pristinePath: pristinePath(key),
        incomingPath: incoming?.incomingPath ?? null,
        needsResolution: false,
      };
      const snapshots = new Map(skillSnapshots);
      for (const [path, value] of manifestSnapshot) snapshots.set(path, value);
      const decision: Decision = { outcome, key, snapshots };
      report.files.push(outcome);
      decisions.push(decision);
      if (protectedReason) {
        outcome.action = "kept";
        outcome.reason = protectedReason;
        decision.protected = true;
        continue;
      }
      try {
        if (manifestError) throw new Error(manifestError);
        const live = await inspect(root, outcome.path, snapshots);
        if (live.kind !== "absent" && live.kind !== "file") {
          outcome.action = "kept";
          outcome.reason = "Protected live file";
          decision.protected = true;
          continue;
        }
        const stored = await inspect(root, outcome.pristinePath, snapshots);
        if (stored.kind !== "absent" && stored.kind !== "file")
          throw new Error("Protected pristine file");
        let base: string | undefined;
        if (provenance) {
          if (
            stored.kind !== "file" ||
            digest(stored.content) !== provenance.digest
          )
            throw new Error(
              "Pristine bytes are missing or fail their recorded digest",
            );
          base = stored.content;
        } else if (stored.kind !== "absent")
          throw new Error("Pristine bytes have no valid ownership record");
        const local = live.kind === "file" ? live.content : undefined;
        if (base === undefined && local !== undefined) {
          const candidates = history.releases
            .filter((release) => release.files[key] === digest(local))
            .map((release) => release.version);
          if (local === incoming?.content)
            candidates.push(distribution.version);
          if (!candidates.length)
            throw new Error(
              "Unknown legacy content; pristine base is unavailable (no exact released template match)",
            );
          outcome.previous = versions(candidates);
          base = local;
        }
        if (!incoming) {
          decision.retire = true;
          if (local === undefined || local === base) {
            outcome.action = "removed";
          } else {
            outcome.action = "kept";
            outcome.reason =
              "Removed upstream; customized file is now repository-local";
          }
          continue;
        }
        decision.baseline = incoming.content;
        if (local === undefined) {
          outcome.action = base === undefined ? "installed" : "adopted";
          decision.content = incoming.content;
        } else if (local === incoming.content || base === incoming.content) {
          outcome.action = "current";
        } else if (local === base) {
          outcome.action = "adopted";
          decision.content = incoming.content;
        } else {
          // A base-less unknown file already failed above. Git is needed only
          // for true divergence, never for byte-equal adoption or init.
          const merge = await mergeText(
            base as string,
            local,
            incoming.content,
            dependencies.mergeRunner,
          );
          if (merge.conflicts.length === 0) {
            outcome.action = "merged";
            decision.content = merge.marked;
          } else {
            outcome.needsResolution = true;
            if (options.dryRun || options.agent === false)
              throw new Error(
                options.dryRun
                  ? "Dry run: overlapping edits would need resolution"
                  : "Overlapping edits; agent resolution disabled",
              );
            resolver ??= (
              dependencies.createResolver ??
              (() => createResolver(dependencies.resolver))
            )();
            const proposal = await resolver({
              projectDirectory: root,
              path: outcome.path,
              base: base as string,
              local,
              incoming: incoming.content,
              merge,
            });
            decision.content = reconstruct(merge, proposal, name, skill);
            outcome.action = "resolved";
            outcome.needsResolution = false;
          }
        }
        if (decision.content !== undefined)
          validateFile(decision.content, name, skill);
      } catch (error) {
        outcome.action = "conflicted";
        outcome.reason = sanitizeCritiqueDiagnostic(error);
        delete decision.content;
        delete decision.baseline;
        delete decision.retire;
      }
    }
    // Identity establishes ownership only with provenance or exact known bytes.
    if (!canonicalAbsent && identity === skill && !tracked.length) {
      const main = decisions.find((value) => value.key === `${skill}/SKILL.md`);
      if (
        main?.outcome.action === "conflicted" &&
        main.outcome.previous.kind === "unknown"
      )
        links.delete(skill);
    }
  }
  report.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  report.previous = previousSummary(report.files);
  if (options.dryRun) return report;
  // Decisions and resolver calls finish before any project write. Recheck all
  // relevant original inputs; update expectations only for our own writes.
  const ownSnapshots = new Map<string, string>();
  for (const decision of decisions) {
    if (decision.protected || decision.outcome.action === "conflicted")
      continue;
    const { outcome, key } = decision;
    try {
      const expected = new Map(decision.snapshots);
      for (const [path, value] of ownSnapshots)
        if (expected.has(path)) expected.set(path, value);
      await unchanged(root, expected);
      const next: PristineManifest = {
        schema: 1,
        files: { ...manifest.files },
      };
      const writes: Write[] = [];
      if (decision.retire) {
        if (
          outcome.action === "removed" &&
          (await inspect(root, outcome.path)).kind !== "absent"
        )
          writes.push({ path: outcome.path, content: undefined });
        writes.push({ path: outcome.pristinePath, content: undefined });
        delete next.files[key];
      } else {
        if (decision.content !== undefined)
          writes.push({ path: outcome.path, content: decision.content });
        if (decision.baseline === undefined) continue;
        const base = await inspect(root, outcome.pristinePath);
        if (base.kind !== "file" || base.content !== decision.baseline)
          writes.push({
            path: outcome.pristinePath,
            content: decision.baseline,
          });
        next.files[key] = {
          version: distribution.version,
          digest: digest(decision.baseline),
        };
      }
      if (manifestBytes(next) !== manifestBytes(manifest))
        writes.push({ path: manifestPath, content: manifestBytes(next) });
      await applyWrites(root, writes, dependencies.apply);
      manifest = next;
      // Include created parent directories, whose absence was snapshotted.
      for (const write of writes) {
        const refreshed = new Map<string, string>();
        await inspect(root, write.path, refreshed);
        for (const [path, value] of refreshed) ownSnapshots.set(path, value);
      }
    } catch (error) {
      outcome.action = "conflicted";
      outcome.reason = sanitizeCritiqueDiagnostic(error);
    }
  }
  for (const [skill, link] of links) {
    const main = decisions.find((value) => value.key === `${skill}/SKILL.md`);
    if (!main || main.protected || main.outcome.action === "conflicted")
      continue;
    try {
      const expected = new Map(link.snapshots);
      for (const [path, value] of ownSnapshots)
        if (expected.has(path)) expected.set(path, value);
      await unchanged(root, expected);
      if (main.outcome.action === "removed") {
        if (!link.missing) await rm(join(root, discoveryPath(skill)));
        // Never recurse: local support files keep their directory intact.
        try {
          await rmdir(join(root, canonicalPath(skill)));
        } catch {
          /* Not empty. */
        }
      } else if (link.missing) {
        if (
          skillIdentity(
            (
              (await inspect(root, `${canonicalPath(skill)}/SKILL.md`)) as {
                content?: string;
              }
            ).content ?? "",
          ) !== skill
        )
          continue;
        const parent = dirname(discoveryPath(skill));
        await inspect(root, `${parent}/.idiom-safety-check`);
        await mkdir(join(root, parent), { recursive: true });
        await symlink(
          discoveryTarget(skill),
          join(root, discoveryPath(skill)),
          "dir",
        );
        const refreshed = new Map<string, string>();
        await inspect(root, discoveryPath(skill), refreshed);
        for (const [path, value] of refreshed) ownSnapshots.set(path, value);
      }
    } catch (error) {
      report.discoveryConflicts.push({
        path: discoveryPath(skill),
        reason: sanitizeCritiqueDiagnostic(error),
      });
    }
  }
  return report;
}
