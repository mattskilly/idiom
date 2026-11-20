import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { reservePort } from "../../src/capture/port.js";
import { run } from "../../src/cli.js";
import { initProject } from "../../src/commands/init.js";
import { fixtureCommand } from "./fixture-server.js";

const exec = promisify(execFile);

export const page = (html: string) =>
  `// html: ${html}\nexport default function Page() { return null; }\n`;

/**
 * A repository whose server renders each route from the checked-out source,
 * so a capture of the base (its own worktree) sees the base's markup. State
 * s1 expects #a and #b; removing either is a blocker finding.
 */
export async function baseFixture() {
  const directory = await mkdtemp(join(tmpdir(), "idiom-gate-base-"));
  const git = async (...args: string[]) =>
    (await exec("git", args, { cwd: directory })).stdout.trim();
  const write = async (path: string, content: string) => {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), content);
  };
  const commit = async (message: string) => {
    await git("add", "-A");
    await git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      message,
    );
    return git("rev-parse", "HEAD");
  };
  await initProject({ project: directory, yes: true });
  const reservation = await reservePort(0);
  const port = reservation.port;
  await reservation.release();
  await write(
    ".gitignore",
    ".idiom/reports/\n.idiom/cache/\n.idiom/agent-state.json\n",
  );
  await write(
    ".idiom/project.json",
    JSON.stringify({
      version: 1,
      app: { name: "Base fixture", framework: "nextjs" },
      server: {
        build: "node -e 0",
        start: fixtureCommand(
          join(import.meta.dirname, "../fixtures/base-gate/server.mjs"),
        ),
        port,
        readyUrl: `http://127.0.0.1:${port}/ready`,
        env: { PORT: String(port) },
      },
      viewports: [{ name: "wide", width: 800, height: 600 }],
      colorSchemes: ["light"],
      checks: { probe: { enabled: false } },
      capture: { settleMs: 0 },
      design: {},
      model: { provider: "anthropic", model: "unused" },
    }),
  );
  await write(
    ".idiom/flows/site.json",
    JSON.stringify({
      id: "site",
      title: "Site",
      setup: [],
      intent: [],
      states: [
        { id: "s0", description: "Home", url: "/r0", expect: {} },
        {
          id: "s1",
          description: "Detail",
          url: "/r1",
          expect: { selectorPresent: ["#a", "#b"] },
        },
      ],
    }),
  );
  await write("app/r0/page.tsx", page("<h1>Home</h1>"));
  await write(
    "app/r1/page.tsx",
    page('<h1>Detail</h1><p id="a">A</p><p id="b">B</p>'),
  );
  await git("init", "--quiet", "--initial-branch=main");
  await commit("initial");
  return {
    directory,
    git,
    write,
    commit,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

export async function cli(directory: string, args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const status = await run(["node", "idiom", "--project", directory, ...args], {
    stdout: (value) => out.push(value),
    stderr: (value) => err.push(value),
  });
  // As a verify step does: a check rewrites the tracked finding-name
  // registry, which the next gate would otherwise read as a UI change.
  await exec("git", ["checkout", "--", ".idiom/finding-names.json"], {
    cwd: directory,
  }).catch(() => undefined);
  return { status, out: out.join("\n"), err: err.join("\n") };
}
