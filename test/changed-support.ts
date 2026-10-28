import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { reservePort } from "../src/capture/port.js";
import { initProject } from "../src/commands/init.js";

const exec = promisify(execFile);
export async function changedFixture(
  files: Record<string, string> = {},
  states = 2,
) {
  const directory = await mkdtemp(join(tmpdir(), "idiom-changed-"));
  const git = async (...args: string[]) =>
    (await exec("git", args, { cwd: directory })).stdout;
  const write = async (path: string, content: string) => {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), content);
  };
  const commit = async (message = "fixture") => {
    await git("add", ".");
    await git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      message,
    );
    return (await git("rev-parse", "HEAD")).trim();
  };
  await initProject({ project: directory, yes: true });
  const reservation = await reservePort(0);
  const port = reservation.port;
  await reservation.release();
  await write(
    ".gitignore",
    ".idiom/reports/\n.idiom/cache/\n.idiom/agent-state.json\naudit.txt\nignored\n",
  );
  await write(
    ".idiom/project.json",
    JSON.stringify({
      version: 1,
      app: { name: "Changed fixture", framework: "nextjs" },
      server: {
        build: "node -e 0",
        start: `node '${join(import.meta.dirname, "fixtures/faster-checks/server.mjs")}'`,
        port,
        readyUrl: `http://127.0.0.1:${port}/ready`,
        env: { PORT: String(port), AUDIT_FILE: join(directory, "audit.txt") },
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
      states: Array.from({ length: states }, (_, index) => ({
        id: `s${index}`,
        description: `State ${index}`,
        url: `/r${index}`,
        expect: {},
      })),
    }),
  );
  for (let i = 0; i < states; i++)
    await write(
      `app/r${i}/page.tsx`,
      "export default function Page() { return <main />; }\n",
    );
  for (const [path, content] of Object.entries(files))
    await write(path, content);
  await git("init", "--quiet", "--initial-branch=main");
  await commit();
  return {
    directory,
    port,
    git,
    write,
    commit,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}
