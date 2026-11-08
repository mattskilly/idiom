import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { redactCredentials } from "../critique/redact.js";
import { readTemplate } from "../templates.js";
import { IDIOM_VERSION } from "../version.js";
import { detectWiring, wiringFacts } from "../wiring/detect.js";
import type {
  Proposal,
  WiringDetection,
  WiringReport,
} from "../wiring/types.js";

export type SetupPackageManager = "bun" | "pnpm" | "yarn" | "npm";

export type ScaffoldFileState = "missing" | "scaffold" | "edited";

/**
 * Bounded, read-only facts about a repository that make the setup prompt
 * repository-aware. Never holds env file contents or `server.env` values.
 */
export type SetupFacts = {
  idiomVersion: string;
  /** The project root; the prompt renders it as ".", never as a path. */
  projectDirectory: string;
  packageManager: SetupPackageManager | undefined;
  runScript: string | undefined;
  scripts: { name: string; command: string }[];
  frameworks: string[];
  server:
    | {
        start?: string;
        build?: string;
        port?: number;
        readyUrl?: string;
        scaffoldDefaults: boolean;
      }
    | undefined;
  flows: { id: string; states: number }[];
  siteRoutes: { state: string; path?: string }[];
  scaffoldFiles: { product: ScaffoldFileState; design: ScaffoldFileState };
  seedCandidates: string[];
  envExample: string | undefined;
  /** Wiring signals by name, PATH availability, and init's outcome when known. */
  wiring?: SetupWiringFacts | undefined;
};

export type SetupWiringFacts = {
  found: string[];
  agents: { claude: boolean; codex: boolean };
  /** Surfaces init wired or found already wired, when it ran. */
  wired?: string[];
  /** Surfaces init found but left: skipped, default off, declined, protected. */
  left?: string[];
};

/** Bounded: surface names only, never file contents or executable paths. */
export function setupWiringFacts(
  detection: WiringDetection,
  report?: WiringReport,
): SetupWiringFacts {
  const { found, agents } = wiringFacts(detection);
  if (report === undefined) return { found, agents };
  const done = (row: Proposal) =>
    row.disposition === "unchanged" ||
    (report.mode === "applied" &&
      (row.disposition === "create" || row.disposition === "update"));
  return {
    found,
    agents,
    wired: report.proposals.filter(done).map((row) => row.surface),
    left: report.proposals
      .filter((row) => row.disposition !== "unavailable" && !done(row))
      .map((row) => row.surface),
  };
}

export const MAX_SETUP_SCRIPTS = 20;
export const MAX_SETUP_ROUTES = 30;
export const MAX_SETUP_SCRIPT_CHARS = 200;

const LOCKFILES: [string, SetupPackageManager][] = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];

const RUN_SCRIPT: Record<SetupPackageManager, string> = {
  bun: "bun run",
  pnpm: "pnpm",
  yarn: "yarn",
  npm: "npm run",
};

const RELEVANT_SCRIPT =
  /^(dev|start|serve|preview|build|seed|db:|prisma|fixtures?|e2e|test:e2e|storybook)/i;

const FRAMEWORKS = [
  "next",
  "vite",
  "astro",
  "nuxt",
  "@sveltejs/kit",
  "electron",
  "react-scripts",
  "gatsby",
];

const SEED_CANDIDATES = [
  "prisma/seed.ts",
  "prisma/seed.js",
  "db/seeds.rb",
  "seed",
  "seeds",
  "scripts/seed.ts",
  "scripts/seed.js",
  "scripts/seed.mjs",
  "fixtures",
  "test/fixtures",
  "tests/fixtures",
  "e2e/fixtures",
  "playwright/fixtures",
  "cypress/fixtures",
  "supabase/seed.sql",
];

const ENV_EXAMPLES = [".env.example", ".env.sample", ".env.template"];

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function clip(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

async function packageManager(
  projectDirectory: string,
): Promise<SetupPackageManager | undefined> {
  for (const [file, manager] of LOCKFILES)
    if (await exists(join(projectDirectory, file))) return manager;
  return undefined;
}

function relevantScripts(
  manifest: Record<string, unknown> | undefined,
): SetupFacts["scripts"] {
  const scripts = record(manifest?.scripts) ?? {};
  return Object.entries(scripts)
    .filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" &&
        (RELEVANT_SCRIPT.test(entry[0]) || /seed|fixture/i.test(entry[0])),
    )
    .slice(0, MAX_SETUP_SCRIPTS)
    .map(([name, command]) => ({
      name,
      command: clip(
        redactCredentials(command.replace(/\s+/g, " ").trim()),
        MAX_SETUP_SCRIPT_CHARS,
      ),
    }));
}

function frameworks(manifest: Record<string, unknown> | undefined): string[] {
  const names = new Set([
    ...Object.keys(record(manifest?.dependencies) ?? {}),
    ...Object.keys(record(manifest?.devDependencies) ?? {}),
  ]);
  const found = FRAMEWORKS.filter((name) => names.has(name));
  if ([...names].some((name) => name.startsWith("@remix-run/")))
    found.push("@remix-run/*");
  return found.sort();
}

async function serverFacts(
  projectDirectory: string,
): Promise<SetupFacts["server"]> {
  const project = record(
    await readJson(join(projectDirectory, ".idiom", "project.json")),
  );
  const server = record(project?.server);
  if (server === undefined) return undefined;
  const template = record(
    record(JSON.parse(await readTemplate("project.json")))?.server,
  );
  const start = text(server.start);
  const build = text(server.build);
  const readyUrl = text(server.readyUrl);
  const port = typeof server.port === "number" ? server.port : undefined;
  return {
    ...(start === undefined
      ? {}
      : { start: clip(redactCredentials(start), MAX_SETUP_SCRIPT_CHARS) }),
    ...(build === undefined
      ? {}
      : { build: clip(redactCredentials(build), MAX_SETUP_SCRIPT_CHARS) }),
    ...(port === undefined ? {} : { port }),
    ...(readyUrl === undefined ? {} : { readyUrl: clip(readyUrl, 200) }),
    scaffoldDefaults:
      start === template?.start &&
      readyUrl === template?.readyUrl &&
      port === template?.port,
  };
}

async function flowFacts(
  projectDirectory: string,
): Promise<Pick<SetupFacts, "flows" | "siteRoutes">> {
  const directory = join(projectDirectory, ".idiom", "flows");
  let names: string[];
  try {
    names = (await readdir(directory))
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch {
    return { flows: [], siteRoutes: [] };
  }
  const flows: SetupFacts["flows"] = [];
  let siteRoutes: SetupFacts["siteRoutes"] = [];
  for (const name of names) {
    const manifest = record(await readJson(join(directory, name)));
    const states = Array.isArray(manifest?.states) ? manifest.states : [];
    flows.push({
      id: text(manifest?.id) ?? basename(name, ".json"),
      states: states.length,
    });
    if (name === "site.json")
      siteRoutes = states
        .map(record)
        .filter((state) => text(state?.id) !== undefined)
        .slice(0, MAX_SETUP_ROUTES)
        .map((state) => {
          const path = text(state?.url);
          return {
            state: clip(String(state?.id), 100),
            ...(path === undefined ? {} : { path: clip(path, 200) }),
          };
        });
  }
  flows.sort((left, right) => left.id.localeCompare(right.id));
  return { flows, siteRoutes };
}

async function scaffoldFileState(
  path: string,
  template: "PRODUCT.md" | "DESIGN.md",
): Promise<ScaffoldFileState> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    return "missing";
  }
  return content === (await readTemplate(template)) ? "scaffold" : "edited";
}

/** Reads what setup needs to know; lenient, so half-configured repos work. */
export async function collectSetupFacts(
  projectDirectory: string,
  wiring?: WiringReport,
): Promise<SetupFacts> {
  const manifest = record(
    await readJson(join(projectDirectory, "package.json")),
  );
  const manager = await packageManager(projectDirectory);
  const seedCandidates: string[] = [];
  for (const candidate of SEED_CANDIDATES)
    if (await exists(join(projectDirectory, candidate)))
      seedCandidates.push(candidate);
  let envExample: string | undefined;
  for (const candidate of ENV_EXAMPLES)
    if (await exists(join(projectDirectory, candidate))) {
      envExample = candidate;
      break;
    }
  return {
    idiomVersion: IDIOM_VERSION,
    projectDirectory,
    packageManager: manager,
    runScript:
      manager === undefined
        ? manifest === undefined
          ? undefined
          : RUN_SCRIPT.npm
        : RUN_SCRIPT[manager],
    scripts: relevantScripts(manifest),
    frameworks: frameworks(manifest),
    server: await serverFacts(projectDirectory),
    ...(await flowFacts(projectDirectory)),
    scaffoldFiles: {
      product: await scaffoldFileState(
        join(projectDirectory, "PRODUCT.md"),
        "PRODUCT.md",
      ),
      design: await scaffoldFileState(
        join(projectDirectory, "DESIGN.md"),
        "DESIGN.md",
      ),
    },
    seedCandidates,
    envExample,
    wiring: setupWiringFacts(
      wiring?.detection ?? (await detectWiring(projectDirectory)),
      wiring,
    ),
  };
}
