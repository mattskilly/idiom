import type { GitRead } from "../changed/git.js";
import type { Confirmation } from "../confirmation.js";
import type { ApplyDependencies, Entry, Write } from "../skills/paths.js";

export const WIRING_SURFACES = [
  "agents",
  "claude",
  "cursor",
  "github",
  "husky",
  "lefthook",
  "autobuild-landing",
  "autobuild-gate",
  "autobuild-verifier",
  "autobuild-plan",
  "autobuild-implement",
  "autobuild-code-review",
] as const;
export type WiringSurface = (typeof WIRING_SURFACES)[number];
export type WiringOptions = {
  wire?: boolean | undefined;
  dryRun?: boolean | undefined;
  skipWiring?: string[] | undefined;
  gitHook?: boolean | undefined;
  nightly?: boolean | undefined;
  designReview?: boolean | undefined;
  /** A person will see the plan at a prompt: the existing gate is offered. */
  offerGate?: boolean | undefined;
  /** Offer installed phase skill customizations at an interactive prompt. */
  offerAutobuildSkills?: boolean | undefined;
};
export type Signal = { detected: boolean; entry?: Entry; reason?: string };
export type WiringDetection = {
  signals: Record<string, Signal>;
  agents: { claude: boolean; codex: boolean };
  defaultBranch?: string;
  branchReason: string;
  setup?: {
    manager: "bun" | "pnpm" | "yarn" | "npm";
    version?: string;
    command: string;
  };
  setupReason?: string;
};
export type DetectionDependencies = {
  git?: GitRead;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  executable?: (path: string) => Promise<boolean>;
};
export type Disposition =
  | "create"
  | "update"
  | "unchanged"
  | "skipped"
  | "unavailable"
  | "protected";
export type Proposal = {
  surface: WiringSurface;
  selected: boolean;
  path: string;
  disposition: Disposition;
  reason: string;
  preview?: string;
};
export type Writer = {
  candidate: string;
  reason?: string;
  /** Changes beyond the text diff, such as created skill files and links. */
  extra?: string;
};
/** How to run `idiom nightly` on this machine instead of in CI; never written. */
export type NightlyScheduleOffer = { cron: string; launchd: string };
export type WiringPlan = {
  detection: WiringDetection;
  schedule?: NightlyScheduleOffer;
  proposals: Proposal[];
  writes: Write[];
  snapshots: Map<string, string>;
  /** Integration-owned directory/link transactions surround the regular-file batch. */
  apply?: (writes: Write[], dependencies?: ApplyDependencies) => Promise<void>;
};
export type WiringReport = {
  mode: "applied" | "declined" | "preview" | "available";
  detection: WiringDetection;
  proposals: Proposal[];
  schedule?: NightlyScheduleOffer | undefined;
};
export type WiringSelection = { selected: WiringSurface[]; nightly: boolean };
export type SelectWiring = (request: {
  proposals: Proposal[];
  defaults: WiringSelection;
}) => Promise<WiringSelection>;
export type WiringDependencies = DetectionDependencies & {
  select?: SelectWiring;
  confirm?: Confirmation;
  interactive?: boolean;
  apply?: ApplyDependencies;
};
