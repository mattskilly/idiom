import { parseDocument, stringify } from "yaml";
import { replaceSection } from "./sections.js";
import type { WiringDetection, Writer } from "./types.js";

/** Shared by the two inline Node scripts; invalid/missing manifests fail visibly. */
export const DISCOVER_FLOWS = `const { readdirSync, readFileSync, lstatSync } = require('node:fs');
const { join, basename } = require('node:path');
const directory = '.idiom/flows';
let names;
try { names = readdirSync(directory).filter(name => name.endsWith('.json')).sort(); }
catch { throw new Error('No flows. Finish Idiom setup, commit .idiom/flows/<id>.json, and run idiom init --validate.'); }
const flows = names.map(name => {
  const path = join(directory, name);
  if (!lstatSync(path).isFile()) throw new Error('Flow must be a regular file: ' + path);
  const flow = JSON.parse(readFileSync(path, 'utf8'));
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(flow.id) || flow.id !== basename(name, '.json') || !Array.isArray(flow.states) || !flow.states.length)
    throw new Error('Invalid or empty flow: ' + path + '. Run idiom validate and commit a runnable manifest.');
  return flow.id;
});
if (!flows.length) throw new Error('No flows. Finish Idiom setup, commit .idiom/flows/<id>.json, and run idiom init --validate.');`;
export const PR_DISCOVERY = `${DISCOVER_FLOWS}
require('node:fs').appendFileSync(process.env.GITHUB_OUTPUT, 'flow=' + flows[0] + '\\n');`;
export const FULL_CHECK = `${DISCOVER_FLOWS}
const { spawnSync } = require('node:child_process');
let failed = false;
for (const flow of flows) {
  const result = spawnSync('idiom', ['check', flow, '--all', '--fail-on', 'major'], { stdio: 'inherit' });
  if (result.error || result.status !== 0) failed = true;
}
process.exitCode = failed ? 1 : 0;`;
/** The scheduled run: proposals to a directory, since CI has no tracker CLI. */
export const NIGHTLY_COMMAND =
  "idiom nightly --tracker directory --out .idiom/reports/nightly";
const inline = (script: string) => `node <<'IDIOM_NODE'\n${script}\nIDIOM_NODE`;

function runtime(setup: NonNullable<WiringDetection["setup"]>): object[] {
  if (setup.manager === "bun")
    return [
      {
        uses: "oven-sh/setup-bun@v2",
        with: { "bun-version": setup.version ?? "latest" },
      },
    ];
  if (setup.manager === "pnpm" || setup.manager === "yarn")
    return [
      {
        name: `Set up ${setup.manager}`,
        run: `npm install --global corepack\ncorepack enable\ncorepack prepare ${setup.manager}@${setup.version ?? (setup.manager === "yarn" ? "1.22.22" : "latest")} --activate`,
      },
    ];
  return setup.version
    ? [{ name: "Set up npm", run: `npm install --global npm@${setup.version}` }]
    : [];
}
export function githubWriter(
  source: string,
  detection: WiringDetection,
  nightly: boolean,
): Writer {
  if (!detection.setup)
    throw new Error(detection.setupReason ?? "Dependency setup unavailable");
  const setup = detection.setup;
  const checkout = {
    uses: "actions/checkout@v5",
    with: { "fetch-depth": 0, "persist-credentials": false },
  };
  const node = {
    uses: "actions/setup-node@v6",
    with: { "node-version": "24", "package-manager-cache": false },
  };
  const install = {
    name: "Install published Idiom and matching Chromium",
    run: 'npm install --prefix "$RUNNER_TEMP/idiom-cli" --no-package-lock @mattskilly/idiom@latest\necho "$RUNNER_TEMP/idiom-cli/node_modules/.bin" >> "$GITHUB_PATH"\nnode "$RUNNER_TEMP/idiom-cli/node_modules/playwright/cli.js" install --with-deps chromium',
  };
  const upload = (name: string) => ({
    name: "Upload reports",
    if: "always()",
    uses: "actions/upload-artifact@v7",
    with: {
      name: `${name}-\${{ github.run_id }}-\${{ github.run_attempt }}`,
      path: ".idiom/reports/",
      "if-no-files-found": "warn",
    },
  });
  const pushed =
    "github.event_name == 'push' && github.ref == format('refs/heads/{0}', github.event.repository.default_branch)";
  // The ledger is what stops each night re-proposing the same clusters.
  const ledger = {
    path: ".idiom/filed-tickets.json",
    key: "idiom-filed-${{ github.run_id }}",
  };
  const workflow = {
    name: "Idiom design QA",
    on: {
      pull_request: {},
      push: detection.defaultBranch
        ? { branches: [detection.defaultBranch] }
        : {},
      ...(nightly ? { schedule: [{ cron: "17 3 * * *" }] } : {}),
    },
    permissions: { contents: "read" },
    concurrency: {
      group:
        "idiom-${{ github.event_name }}-${{ github.event.pull_request.number || github.ref }}",
      "cancel-in-progress": true,
    },
    jobs: {
      "pull-request": {
        if: "github.event_name == 'pull_request'",
        "runs-on": "ubuntu-latest",
        permissions: { contents: "read", "pull-requests": "write" },
        steps: [
          {
            ...checkout,
            with: {
              ...checkout.with,
              ref: "${{ github.event.pull_request.head.sha }}",
            },
          },
          node,
          ...runtime(setup),
          {
            name: "Discover first PR flow (sorted root manifests)",
            id: "flow",
            run: inline(PR_DISCOVERY),
          },
          {
            uses: "mattskilly/idiom@main",
            with: {
              flow: "${{ steps.flow.outputs.flow }}",
              project: ".",
              version: "latest",
              "fail-on": "major",
              "setup-command": setup.command,
            },
          },
        ],
      },
      "full-check": {
        // With nightly selected, the schedule runs the nightly job instead.
        if: nightly ? pushed : `github.event_name == 'schedule' || (${pushed})`,
        "runs-on": "ubuntu-latest",
        permissions: { contents: "read" },
        steps: [
          checkout,
          node,
          ...runtime(setup),
          install,
          { name: "Install app dependencies", run: setup.command },
          { name: "Check every flow in full", run: inline(FULL_CHECK) },
          upload("idiom-full"),
        ],
      },
      ...(nightly
        ? {
            nightly: {
              if: "github.event_name == 'schedule'",
              "runs-on": "ubuntu-latest",
              permissions: { contents: "read" },
              steps: [
                checkout,
                node,
                ...runtime(setup),
                install,
                { name: "Install app dependencies", run: setup.command },
                {
                  name: "Restore the filed-tickets ledger",
                  uses: "actions/cache/restore@v4",
                  with: { ...ledger, "restore-keys": "idiom-filed-" },
                },
                {
                  name: "Check every flow since its baseline and propose new findings",
                  run: NIGHTLY_COMMAND,
                },
                {
                  name: "Save the filed-tickets ledger",
                  if: "always()",
                  uses: "actions/cache/save@v4",
                  with: ledger,
                },
                upload("idiom-nightly"),
              ],
            },
          }
        : {}),
    },
  };
  const body = `# PR comparison uses the first flow; default-branch pushes check every flow.\n${nightly ? "# Nightly runs idiom nightly at 03:17 UTC: new findings since each baseline become\n# ticket proposals in the uploaded .idiom/reports/nightly; a cached ledger stops repeats.\n" : ""}# Commit app configuration and fixtures.\n${stringify(workflow, { lineWidth: 0 })}`;
  const candidate = replaceSection(source, "github", body, { reserved: true });
  const parsed = parseDocument(candidate, { uniqueKeys: true });
  if (parsed.errors.length)
    throw new Error(
      `Conflicting workflow YAML: ${parsed.errors.map((error) => error.message).join("; ")}`,
    );
  // Foreign top-level values are allowed only when they do not collide (the parser checks this).
  return {
    candidate,
    reason: `Dependency setup: ${setup.command}${setup.version ? ` (${setup.manager}@${setup.version})` : ""}. ${detection.branchReason}`,
  };
}
