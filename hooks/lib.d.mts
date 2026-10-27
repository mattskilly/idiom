export type Budget = {
  signal: AbortSignal;
  remaining(): number;
  check(): void;
  close(): void;
};
export type HookContext = {
  root: string;
  tree: string;
  git: boolean;
  globs: string[];
  identity: string;
  directory: string;
};
export type UISnapshot = {
  digest: string;
  untracked: boolean;
  ignored: string[];
};
export type CheckMetadata = {
  startedAt: number;
  editId?: string | undefined;
  flow: string;
  scope?: unknown;
};
export type HookState = {
  version: number;
  identity: string;
  editId?: string | undefined;
  pending: Array<{ path: string; at: number }>;
  overflow?: boolean;
  sessions: Record<string, { epoch: string; at: number }>;
  check?: CheckMetadata & { digest: string; completedAt: number; id: string };
};
export const DEFAULT_UI_GLOBS: string[];
export function createBudget(ms?: number): Budget;
export function validGlob(pattern: unknown): boolean;
export function globRegex(pattern: string): RegExp;
export function matchesUI(path: string, globs?: string[]): boolean;
export function resolveContext(
  cwd: string,
  budget: Budget,
): Promise<HookContext | undefined>;
export function normalizePath(
  context: HookContext,
  path: unknown,
  budget: Budget,
): Promise<string | undefined>;
export function snapshot(
  context: HookContext,
  budget: Budget,
  extra?: string[],
  scanIgnored?: boolean,
): Promise<UISnapshot>;
export function readState(
  context: HookContext,
  budget: Budget,
): Promise<HookState>;
export function mutateState(
  context: HookContext,
  budget: Budget,
  update: (state: HookState) => boolean,
  signal?: AbortSignal,
): Promise<boolean>;
export function recordEdit(
  context: HookContext,
  path: string,
  budget: Budget,
): Promise<boolean>;
export function stopDecision(
  state: HookState,
  digest: string,
  initialChanges: boolean,
  session: string,
): boolean;
export function claimStop(
  context: HookContext,
  current: UISnapshot,
  initialChanges: boolean,
  session: string,
  budget: Budget,
): Promise<boolean>;
export function initialChanges(
  context: HookContext,
  current: UISnapshot,
  budget: Budget,
): Promise<boolean>;
export function publishCheck(
  context: HookContext,
  start: UISnapshot,
  end: UISnapshot,
  metadata: CheckMetadata,
  budget: Budget,
  signal?: AbortSignal,
): Promise<boolean>;
export function flowReminder(
  context: HookContext,
  budget: Budget,
): Promise<string>;
export function readInput(
  budget: Budget,
): Promise<Record<string, unknown> | undefined>;
