export type SkillName = "idiom" | "ab-verify-idiom";
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
};
export type UpgradeReport = {
  projectDirectory: string;
  installedVersion: string;
  previous: PreviousVersion | { kind: "mixed"; versions: PreviousVersion[] };
  dryRun: boolean;
  files: FileOutcome[];
  discoveryConflicts: { path: string; reason: string }[];
};
