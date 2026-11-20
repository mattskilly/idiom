export type SkillName = "idiom" | "idiom-verify" | "idiom-fix";
export type DistributionFile = { content: string; incomingPath: string };
export type Distribution = {
  version: string;
  skills: Partial<Record<SkillName, Record<string, DistributionFile>>>;
};
export type FileProvenance = { version: string; digest: string };
export type PristineManifest = {
  schema: 1;
  files: Record<string, FileProvenance>;
};
export type PreviousVersion =
  | { kind: "known"; version: string }
  | { kind: "candidates"; versions: string[] }
  | { kind: "unknown" };
export type Outcome =
  | "current"
  | "adopted"
  | "merged"
  | "resolved"
  | "conflicted"
  | "installed"
  | "removed"
  | "kept";
export type FileOutcome = {
  skill: SkillName;
  path: string;
  action: Outcome;
  previous: PreviousVersion;
  incomingVersion: string;
  pristinePath: string;
  incomingPath: string | null;
  needsResolution: boolean;
  reason?: string;
  /** Diff3 merge text for an overlap; never written to disk. */
  conflictText?: string;
};
export type SkillSummary = {
  name: SkillName;
  outcome: Outcome;
  files: FileOutcome[];
};
export type UpgradeReport = {
  autobuild?: import("../autobuild/setup.js").AutobuildSetupOutcome;
  /** The verify step that fixes new major UI findings inside the build. */
  fixStep?: import("../autobuild/setup.js").AutobuildSetupOutcome;
  /** The finalize step that advances the gate's baseline as builds land. */
  baselineAdvance?: import("../autobuild/setup.js").AutobuildSetupOutcome;
  /** --yes wired the gate: its first baseline, recorded at clean HEAD or named as the next step. */
  firstBaseline?: import("../autobuild/first-baseline.js").FirstBaselineOutcome;
  projectDirectory: string;
  installedVersion: string;
  previous: PreviousVersion | { kind: "mixed"; versions: PreviousVersion[] };
  dryRun: boolean;
  files: FileOutcome[];
  /** One rollup per participating skill; empty when none participated. */
  skills: SkillSummary[];
  discoveryConflicts: { path: string; reason: string }[];
  /** Versioned `.idiom/` files `idiom upgrade` checked (upgrade command only). */
  projectFiles?: import("../migrations/run.js").ProjectFilesReport;
};
