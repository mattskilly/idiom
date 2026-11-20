// Shared by scripts/prove-idiom-fix.mjs and the tests: a throwaway git repo
// holding test/fixtures/idiom-fix, its committed baseline, and a build branch
// whose "UI change" commit plants a spacing regression in the order toolbar.
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const fixtureRoot = join(
  import.meta.dirname,
  "..",
  "test",
  "fixtures",
  "idiom-fix",
);
export const toolbarCss = "components/Toolbar.module.css";
export const goodGap = "gap: 8px;";
export const plantedGap = "gap: 2px;";

async function freePort() {
  return await new Promise((accept, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => accept(address.port));
    });
  });
}

/**
 * Build the fixture repository. `idiom` runs the CLI (argv after `idiom`) in
 * the repository; `start` overrides the server command (tests preload their
 * lifeline). Returns helpers for git and cleanup.
 */
export async function createFixFixture({ idiom, start, directory } = {}) {
  const root = directory ?? (await mkdtemp(join(tmpdir(), "idiom-fix-")));
  const git = async (...args) =>
    (await exec("git", args, { cwd: root, maxBuffer: 64 * 1024 * 1024 }))
      .stdout;
  const commit = async (message) => {
    await git("add", "-A", "--", ".", ":!.ab");
    await git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.com",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      message,
    );
    return (await git("rev-parse", "HEAD")).trim();
  };
  const init = await idiom(root, ["init", "--yes"]);
  if (init.status !== 0) throw new Error(`idiom init failed: ${init.err}`);
  await cp(fixtureRoot, root, { recursive: true, force: true });
  await rm(join(root, "README.md"), { force: true });
  const port = await freePort();
  const projectPath = join(root, ".idiom", "project.json");
  const project = JSON.parse(await readFile(projectPath, "utf8"));
  project.server.port = port;
  project.server.readyUrl = `http://127.0.0.1:${port}/ready`;
  project.server.env = { PORT: String(port) };
  if (start !== undefined) project.server.start = start;
  await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`);
  await writeFile(
    join(root, ".gitignore"),
    ".idiom/reports/\n.idiom/cache/\n.idiom/agent-state.json\n.ab/\n",
  );
  await git("init", "--quiet", "--initial-branch=main");
  const base = await commit("Orders console with an 8px toolbar");
  const seed = await idiom(root, ["check", "orders", "--fail-on", "never"]);
  if (seed.status !== 0) throw new Error(`baseline seed failed: ${seed.err}`);
  const baseline = await commit("Record the orders baseline");
  await git("checkout", "--quiet", "-b", "ab/fixture");
  const css = join(root, toolbarCss);
  // The build's real UI change (centred buttons) carries the regression, so
  // the branch still changes UI once the gap is fixed.
  await writeFile(
    css,
    (await readFile(css, "utf8")).replace(
      goodGap,
      `${plantedGap}\n  align-items: center;`,
    ),
  );
  const change = await commit("Tighten the order toolbar");
  return {
    directory: root,
    port,
    base,
    baseline,
    change,
    git,
    commit,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/** The scripted fixer: what the suggested fix asks for, as a CSS edit. */
export async function scriptedFix(root) {
  const css = join(root, toolbarCss);
  const before = await readFile(css, "utf8");
  if (!before.includes(plantedGap)) return [];
  await writeFile(css, before.replace(plantedGap, goodGap));
  return [toolbarCss];
}
