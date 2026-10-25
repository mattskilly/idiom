import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import {
  applyExplorationEdits,
  createExplorationWorkspace,
} from "../src/explore/workspace.js";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function project() {
  const directory = await mkdtemp(
    join(tmpdir(), "idiom-explore-workspace-test-"),
  );
  directories.push(directory);
  await mkdir(join(directory, "src"));
  await mkdir(join(directory, "node_modules", "runtime"), { recursive: true });
  await writeFile(
    join(directory, "src", "app.tsx"),
    "export const label = 'old';\n",
  );
  await writeFile(join(directory, ".env"), "SECRET=value\n");
  await writeFile(
    join(directory, "node_modules", "runtime", "index.js"),
    "runtime\n",
  );
  await writeFile(join(directory, ".gitignore"), ".env\nnode_modules\n");
  await symlink("app.tsx", join(directory, "src", "link.tsx"));
  await execFileAsync("git", ["init"], { cwd: directory });
  await execFileAsync("git", ["add", "."], { cwd: directory });
  return directory;
}

test("runtime clones preserve ignored inputs while the model mirror excludes them", async () => {
  const directory = await project();
  const workspace = await createExplorationWorkspace(directory);
  directories.push(workspace.root);
  expect(await readFile(join(workspace.runtimeBase, ".env"), "utf8")).toContain(
    "SECRET",
  );
  await expect(
    readFile(join(workspace.mirrorBase, ".env"), "utf8"),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await expect(
    readFile(
      join(workspace.mirrorBase, "node_modules", "runtime", "index.js"),
      "utf8",
    ),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await expect(
    lstat(join(workspace.mirrorBase, "src", "link.tsx")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

test("exact replacements update only disposable regular files and cleanup is idempotent", async () => {
  const directory = await project();
  const workspace = await createExplorationWorkspace(directory);
  const candidate = await workspace.createCandidate("candidate-a");
  await applyExplorationEdits({
    ...candidate,
    edits: [
      {
        path: "src/app.tsx",
        oldText: "label = 'old'",
        newText: "label = 'candidate'",
      },
    ],
  });
  expect(
    await readFile(join(candidate.cloneDirectory, "src", "app.tsx"), "utf8"),
  ).toContain("candidate");
  expect(await readFile(join(directory, "src", "app.tsx"), "utf8")).toContain(
    "old",
  );
  await expect(
    applyExplorationEdits({
      ...candidate,
      edits: [{ path: "src/link.tsx", oldText: "old", newText: "new" }],
    }),
  ).rejects.toThrow();
  await Promise.all([workspace.cleanup(), workspace.cleanup()]);
  await expect(lstat(workspace.root)).rejects.toMatchObject({ code: "ENOENT" });
});

test("exact replacements preserve dollar substitution sequences literally", async () => {
  const directory = await project();
  const workspace = await createExplorationWorkspace(directory);
  const candidate = await workspace.createCandidate("candidate-dollar");
  const newText = `label = "before $& $$ $\` $' after"`;
  await applyExplorationEdits({
    ...candidate,
    edits: [{ path: "src/app.tsx", oldText: "label = 'old'", newText }],
  });
  expect(
    await readFile(join(candidate.cloneDirectory, "src", "app.tsx"), "utf8"),
  ).toContain(newText);
  expect(
    await readFile(join(candidate.mirrorDirectory, "src", "app.tsx"), "utf8"),
  ).toContain(newText);
  await workspace.cleanup();
});

test("refinement evidence keeps baseline and selected captures under distinct names", async () => {
  const directory = await project();
  const baseline = join(directory, "baseline.png");
  const selected = join(directory, "selected.png");
  await writeFile(baseline, "baseline-bytes");
  await writeFile(selected, "selected-bytes");
  const workspace = await createExplorationWorkspace(directory);
  const stagedBaseline = await workspace.stageEvidence([baseline]);
  const candidate = await workspace.createCandidate("candidate-a");
  const stagedSelected = await workspace.stageEvidence(
    [selected],
    candidate.mirrorDirectory,
    "selected",
  );
  const copiedBaseline = (stagedBaseline[0] as string).replace(
    workspace.mirrorBase,
    candidate.mirrorDirectory,
  );
  expect(stagedBaseline[0]).toContain("baseline-001-baseline.png");
  expect(stagedSelected[0]).toContain("selected-001-selected.png");
  expect(await readFile(copiedBaseline, "utf8")).toBe("baseline-bytes");
  expect(await readFile(stagedSelected[0] as string, "utf8")).toBe(
    "selected-bytes",
  );
  expect(copiedBaseline).not.toBe(stagedSelected[0]);
  await workspace.cleanup();
});

test("design-token source stays readable and editable while credential names stay excluded", async () => {
  const directory = await project();
  await mkdir(join(directory, "src", "theme", "tokens"), { recursive: true });
  await writeFile(join(directory, "tokens.css"), ":root { --space: 8px; }\n");
  await writeFile(join(directory, "tokens.ts"), "export const space = 8;\n");
  await writeFile(join(directory, "design-tokens.css"), ":root {}\n");
  await writeFile(
    join(directory, "src", "theme", "tokens", "palette.css"),
    ":root {}\n",
  );
  await writeFile(
    join(directory, "src", "TokenBadge.tsx"),
    "export const TokenBadge = () => null;\n",
  );
  await writeFile(join(directory, "access-token.txt"), "credential\n");
  const workspace = await createExplorationWorkspace(directory);
  for (const path of [
    "tokens.css",
    "tokens.ts",
    "design-tokens.css",
    "src/theme/tokens/palette.css",
    "src/TokenBadge.tsx",
  ]) {
    await expect(
      readFile(join(workspace.mirrorBase, path), "utf8"),
    ).resolves.not.toBe("");
  }
  await expect(
    readFile(join(workspace.mirrorBase, "access-token.txt"), "utf8"),
  ).rejects.toMatchObject({ code: "ENOENT" });
  const candidate = await workspace.createCandidate("candidate-tokens");
  await expect(
    applyExplorationEdits({
      ...candidate,
      edits: [
        {
          path: "tokens.css",
          oldText: "--space: 8px",
          newText: "--space: 12px",
        },
      ],
    }),
  ).resolves.toBeUndefined();
  await workspace.cleanup();
});
