import type { SetupFacts } from "./facts.js";

export const SETUP_PROMPT_BEGIN = "----- BEGIN IDIOM SETUP PROMPT -----";
export const SETUP_PROMPT_END = "----- END IDIOM SETUP PROMPT -----";

/** The prompt's section headings, in order, after the versioned title. */
export const SETUP_PROMPT_HEADINGS = [
  "## What Idiom already knows about this repository",
  "## 1. Start the app: server command, port and readyUrl",
  "## 2. Seed data and test accounts",
  "## 3. Find routes",
  "## 4. Write a first flow of 3–8 states",
  "## 5. Fill PRODUCT.md and DESIGN.md from the repository",
  "## Finish line: idiom init --validate must print ready",
  "## Rules",
] as const;

const NONE = "none found";

function code(value: string): string {
  return `\`${value.replace(/`/g, "'")}\``;
}

function list(values: string[]): string {
  return values.length === 0 ? NONE : values.join(", ");
}

function knownFacts(facts: SetupFacts): string[] {
  const lines = [
    `- Package manager (from lockfiles): ${facts.packageManager ?? NONE}${facts.runScript === undefined ? "" : `; run scripts with ${code(facts.runScript)}`}`,
    `- Frameworks (from package.json dependencies): ${list(facts.frameworks)}`,
  ];
  if (facts.scripts.length === 0)
    lines.push("- Relevant package.json scripts: none found");
  else {
    lines.push("- Relevant package.json scripts:");
    for (const script of facts.scripts)
      lines.push(`  - ${code(script.name)}: ${code(script.command)}`);
  }
  const server = facts.server;
  if (server === undefined)
    lines.push(
      "- Server config (.idiom/project.json `server`): none found; run `idiom init --yes --no-agent` first",
    );
  else {
    const parts = [
      `start ${server.start === undefined ? NONE : code(server.start)}`,
      `build ${server.build === undefined ? NONE : code(server.build)}`,
      `port ${server.port ?? NONE}`,
      `readyUrl ${server.readyUrl === undefined ? NONE : code(server.readyUrl)}`,
    ];
    lines.push(
      `- Server config (.idiom/project.json \`server\`): ${parts.join("; ")}${server.scaffoldDefaults ? ". These are still the scaffold defaults; replace them." : "."}`,
    );
  }
  lines.push(
    `- Flows (.idiom/flows): ${list(facts.flows.map((flow) => `${flow.id} (${flow.states} states)`))}`,
  );
  if (facts.siteRoutes.length === 0)
    lines.push(
      "- Routes found by `idiom init --flows` (site.json): none found",
    );
  else {
    lines.push(
      "- Routes found by `idiom init --flows` (.idiom/flows/site.json):",
    );
    for (const route of facts.siteRoutes)
      lines.push(
        `  - ${code(route.state)}${route.path === undefined ? "" : ` → ${code(route.path)}`}`,
      );
  }
  lines.push(
    `- Seed scripts and fixtures (by path only): ${list(facts.seedCandidates)}`,
    `- Example env file (by name only, contents not read): ${facts.envExample ?? NONE}`,
    `- PRODUCT.md: ${facts.scaffoldFiles.product}; DESIGN.md: ${facts.scaffoldFiles.design} (scaffold = untouched template, edited = human-owned)`,
  );
  return lines;
}

/**
 * The versioned, repository-aware prompt that hands Idiom setup to a coding
 * agent. Deterministic for given facts; starts with `#`, so it is never read
 * as a flag when passed as a positional argument.
 */
export function setupPrompt(facts: SetupFacts): string {
  const [known, start, seed, routes, flow, docs, finish, rules] =
    SETUP_PROMPT_HEADINGS;
  return [
    `# Set up Idiom in this repository (idiom ${facts.idiomVersion} setup prompt)`,
    "",
    "Idiom is a design acceptance layer: it boots this app, captures named UI states and checks them. Your job is to finish its setup in this repository (`.`) so a capture can run, and to stop only when `idiom init --validate` prints `ready`. Use the `idiom` CLI, or the Idiom MCP tools named in parentheses when they are available (`idiom_init`, `idiom_ready`, `idiom_flows`, `idiom_doctor`).",
    "",
    known,
    "",
    ...knownFacts(facts),
    "",
    start,
    "",
    "Find the command that starts the app locally, from the scripts and frameworks above. Set `server.build` (or remove it if there is no build step), `server.start`, `server.port` and `server.readyUrl` in `.idiom/project.json` (see docs/configuration.md#project-file). Prefer a fixed port the start command honors, and a readyUrl that answers once the app can render. Confirm with `idiom doctor` (`idiom_doctor`).",
    "",
    seed,
    "",
    "Use only the repository's own seed scripts, fixtures and example env files (the ones listed above, or others the repo documents). Wire them as flow `setup` steps, or as `server.env` references to variables the repo already defines. **Never use, invent or ask for real credentials, production data or personal accounts.** If the app needs an account the repository cannot create, stop and ask the human how test accounts are provisioned; do not add one yourself.",
    "",
    routes,
    "",
    `With the app running, run \`idiom init --flows --yes --no-agent\` (\`idiom_init\` with \`flows: true\`). Review the TODOs and setup-required routes in the generated \`.idiom/flows/site.json\`. ${facts.siteRoutes.length === 0 ? "No routes have been found yet." : `${facts.siteRoutes.length} route(s) are already listed above.`}`,
    "",
    flow,
    "",
    "Choose one primary user journey and write `.idiom/flows/<id>.json` with 3 to 8 named states. Include at least one empty, loading or error state when the repository can force one (see docs/configuration.md#force-empty-error-and-loading-states). Use stable selectors: `data-testid`, an ARIA role plus accessible name, or a label. Never rely on `nth-child`, generated class names or text that changes with data. Run `idiom validate <id>` until it passes (see docs/configuration.md#flows).",
    "",
    docs,
    "",
    "Follow `.agents/skills/idiom/init.md` (installed by `idiom init`). Mine the repository first, then ask the human only what the code cannot answer. If either file is marked `edited` above, treat it as human-owned: propose changes instead of overwriting it.",
    "",
    finish,
    "",
    "Run `idiom init --validate` (`idiom_ready`) and repeat the steps above until it prints `ready`. If it does not, stop and report the exact `not ready: …` line and its `Fix:` line as the remaining problem. **Do not say setup is done unless it printed `ready`.**",
    "",
    rules,
    "",
    "- Do not disable, skip or weaken checks or rules, and do not edit `.idiom/rules.json` or decisions to silence findings.",
    "- Do not commit, push or open pull requests; leave every change in the working tree for the human to review.",
    "- Do not change application behavior to make setup pass.",
    "- Ask before adding any script to the app.",
    "",
  ].join("\n");
}

/** The prompt between copy-ready delimiter lines. */
export function delimitedSetupPrompt(prompt: string): string[] {
  return [SETUP_PROMPT_BEGIN, prompt.trimEnd(), SETUP_PROMPT_END];
}
