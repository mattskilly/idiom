/**
 * Output contracts shared by `--json` payloads and MCP tool outputs. The MCP
 * server declares outputs from these at runtime (src/mcp/outputs.ts), and
 * src/interface/surfaces.ts classifies them for the contract test.
 */
import { z } from "zod";
import { SURFACE_IDS, SURFACE_STATUSES } from "../doctor/surfaces.js";
import { INTERFACE_VERSION } from "./version.js";

export const runFailureContract = z.looseObject({
  stage: z.enum(["preflight", "server", "capture"]),
  cause: z.string(),
  hint: z.string(),
  message: z.string(),
  paths: z.array(z.string()).optional(),
});

export const surfacesContract = z.looseObject({
  root: z.string(),
  initialized: z.boolean(),
  notice: z.string().optional(),
  ms: z.number(),
  entries: z.array(
    z.looseObject({
      id: z.enum(SURFACE_IDS),
      label: z.string(),
      status: z.enum(SURFACE_STATUSES),
      path: z.string().optional(),
      detail: z.string(),
      fix: z.string().optional(),
    }),
  ),
});

export const doctorReportContract = z.looseObject({
  flow: z.string().optional(),
  ok: z.boolean(),
  steps: z.array(
    z.looseObject({
      id: z.enum([
        "node",
        "config",
        "registry",
        "tree",
        "port",
        "setup",
        "build",
        "start",
        "ready",
        "shutdown",
      ]),
      status: z.enum(["pass", "fail", "warn", "skip"]),
      ms: z.number(),
      detail: z.string().optional(),
      hint: z.string().optional(),
    }),
  ),
  failure: runFailureContract.optional(),
  surfaces: surfacesContract.optional(),
  conditions: z
    .array(
      z.looseObject({
        key: z.string(),
        cause: z.string(),
        line: z.string(),
        mode: z.string(),
        firstSeen: z.string(),
        lastSeen: z.string(),
        runs: z.number(),
        ticket: z.string().optional(),
      }),
    )
    .optional(),
});

/** `idiom doctor --json`. */
export const doctorJsonContract = doctorReportContract.extend({
  interfaceVersion: z.literal(INTERFACE_VERSION),
});

/** The once-per-session newer-version notice (src/update/notice.ts). */
export const updateNoticeContract = z.looseObject({
  current: z.string(),
  latest: z.string(),
  command: z.string(),
});

const stateIdentityContract = z.looseObject({
  flow: z.string(),
  state: z.string(),
});

/**
 * The changed-path selection `check --changed`, `check --gate` and the
 * idiom_check changed form share (src/changed/select.ts). Each file's
 * importChains and uncertainties, and the selection's graph, are experimental
 * and so not declared here.
 */
export const changedSelectionContract = z.looseObject({
  git: z.looseObject({
    repository: z.string(),
    head: z.string(),
    requestedBase: z.string().nullable(),
    resolvedBase: z.string(),
    baseReason: z.string(),
    fallbackReason: z.string().optional(),
  }),
  files: z.array(
    z.looseObject({
      path: z.string(),
      kind: z.enum([
        "route",
        "import",
        "global",
        "unresolved",
        "documentation",
        "non-ui",
      ]),
      reason: z.string(),
      routes: z.array(z.string()),
      states: z.array(stateIdentityContract),
    }),
  ),
  candidates: z.array(stateIdentityContract),
  selected: z.array(stateIdentityContract),
  skipped: z.array(stateIdentityContract),
  fallbackFiles: z.array(z.string()),
});
