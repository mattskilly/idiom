import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createAutobuildDiff } from "../src/autobuild/wiring.js";
import { initProject } from "../src/commands/init.js";
import { collectSetupFacts } from "../src/setup/facts.js";
import {
  AUTOBUILD_SKILLS,
  autobuildSkillWriter,
} from "../src/wiring/autobuild-skills.js";
import { planWiring } from "../src/wiring/plan.js";
import { runWiring, wiringSummaryLines } from "../src/wiring/run.js";
import { markers, sectionSpan } from "../src/wiring/sections.js";
import type { WiringDependencies } from "../src/wiring/types.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
const seams: WiringDependencies = {
  environment: { PATH: "" },
  git: async () => {
    throw new Error("not git");
  },
};
async function temporary() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "idiom-phase-skills-")),
  );
  directories.push(root);
  return root;
}
const fixture = (identity: string) =>
  readFile(
    new URL(`./fixtures/autobuild-skills/${identity}.md`, import.meta.url),
    "utf8",
  );
async function project() {
  const root = await temporary();
  for (const target of AUTOBUILD_SKILLS) {
    await mkdir(dirname(join(root, target.path)), { recursive: true });
    await writeFile(join(root, target.path), await fixture(target.identity));
    await writeFile(
      join(root, dirname(target.path), "support.md"),
      "local support\n",
    );
    const pristine = join(
      root,
      ".agents/skills/.ab-pristine",
      target.identity,
      "SKILL.md",
    );
    await mkdir(dirname(pristine), { recursive: true });
    await writeFile(pristine, await fixture(target.identity));
    const discovery = join(root, ".claude/skills", target.identity);
    await mkdir(dirname(discovery), { recursive: true });
    await symlink(`../../.agents/skills/${target.identity}`, discovery);
  }
  return root;
}
async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const { readdir } = await import("node:fs/promises");
  async function walk(relative: string) {
    for (const name of await readdir(join(root, relative))) {
      const path = relative ? `${relative}/${name}` : name;
      const state = await lstat(join(root, path));
      if (state.isDirectory()) await walk(path);
      else if (state.isFile())
        result[path] = await readFile(join(root, path), "utf8");
      else if (state.isSymbolicLink())
        result[path] = `link:${await readlink(join(root, path))}`;
    }
  }
  await walk("");
  return result;
}
const rows = (report: {
  proposals: { surface: string; selected: boolean; disposition: string }[];
}) =>
  report.proposals.filter((row) =>
    AUTOBUILD_SKILLS.some((t) => t.surface === row.surface),
  );

for (const target of AUTOBUILD_SKILLS) {
  test(`${target.surface}: preserves bytes, refreshes in place and can be removed`, async () => {
    const original = await fixture(target.identity);
    for (const newline of ["\n", "\r\n"]) {
      for (const finalNewline of [true, false]) {
        const source = (finalNewline ? original : original.trimEnd()).replace(
          /\n/g,
          newline,
        );
        const candidate = autobuildSkillWriter(source, target).candidate;
        expect(candidate.startsWith(source)).toBe(true);
        expect(candidate).toContain(target.body.replace(/\n/g, newline));
        expect(autobuildSkillWriter(candidate, target).candidate).toBe(
          candidate,
        );
        if (newline === "\r\n")
          expect(candidate.replace(/\r\n/g, "")).not.toContain("\n");
        const old = candidate.replace(
          target.body.split("\n").at(-1) as string,
          "old instructions",
        );
        expect(autobuildSkillWriter(old, target).candidate).toBe(candidate);
        const span = sectionSpan(candidate, markers(target.surface, "html"));
        if (!span) throw new Error("Expected managed section");
        const removed =
          candidate.slice(0, span.start) +
          candidate.slice(span.end + newline.length);
        expect(removed).toBe(source + (finalNewline ? "" : newline));
      }
    }
    const [begin, end] = markers(target.surface, "html");
    for (const bad of [
      begin,
      end,
      `${end}\n${begin}`,
      `${begin}\n${begin}\n${end}`,
      `${begin}\n${end}\n${end}`,
    ])
      expect(() => autobuildSkillWriter(`${original}${bad}\n`, target)).toThrow(
        /Malformed|duplicate/,
      );
    for (const bad of [`${begin} inline\n${end}`, `${begin}\ninline ${end}`])
      expect(() => autobuildSkillWriter(`${original}${bad}\n`, target)).toThrow(
        /own lines/,
      );
    for (const source of [
      "",
      original.replace(target.identity, "wrong"),
      original.replace("name:", "other:"),
      original.replace("---\n\n#", "\n#"),
      `---\nname: ${target.identity}\n---\n`,
    ])
      expect(() => autobuildSkillWriter(source, target)).toThrow(/frontmatter/);
    expect(() =>
      autobuildSkillWriter(
        original.replace("description:", `${begin}\n${end}\ndescription:`),
        target,
      ),
    ).toThrow(/outside frontmatter/);
  });
}

test("the three bodies carry the phase-specific contract", () => {
  expect(AUTOBUILD_SKILLS[0].body).toContain("`idiom context`");
  expect(AUTOBUILD_SKILLS[0].body).toContain("`.ab/assets/design/`");
  expect(AUTOBUILD_SKILLS[0].body).toContain(
    "checks the implementation is expected to pass",
  );
  expect(AUTOBUILD_SKILLS[1].body).toContain(
    "`idiom check --changed --fail-on major`",
  );
  expect(AUTOBUILD_SKILLS[1].body).toContain("record why and what remains");
  expect(AUTOBUILD_SKILLS[2].body).toContain("an Idiom design asset");
  expect(AUTOBUILD_SKILLS[2].body).toContain("normal review");
});

test("interactive offer has exact diffs and one confirmation for all roles", async () => {
  const root = await project();
  const before = await snapshot(root);
  const confirm = vi.fn(async (request) => {
    expect(request.kind).toBe("apply-wiring");
    for (const target of AUTOBUILD_SKILLS) {
      expect(request.diff).toContain(
        createAutobuildDiff(
          before[target.path] as string,
          autobuildSkillWriter(before[target.path] as string, target).candidate,
          target.path,
        ),
      );
    }
    return true;
  });
  const report = await runWiring(root, {}, { ...seams, confirm }, () => {});
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(rows(report).map((r) => [r.selected, r.disposition])).toEqual([
    [true, "update"],
    [true, "update"],
    [true, "update"],
  ]);
  const after = await snapshot(root);
  for (const [path, bytes] of Object.entries(before))
    if (!AUTOBUILD_SKILLS.some((t) => t.path === path))
      expect(after[path]).toBe(bytes);
  const again = await runWiring(root, { yes: true }, seams, () => {});
  expect(rows(again).map((r) => r.disposition)).toEqual([
    "unchanged",
    "unchanged",
    "unchanged",
  ]);
  expect(await snapshot(root)).toEqual(after);
});

test("bare yes, report-only and noninteractive dry runs never select new sections", async () => {
  for (const options of [
    { yes: true },
    { application: "report-only" as const },
    { dryRun: true },
    {},
  ]) {
    const root = await project();
    const before = await snapshot(root);
    const report = await runWiring(
      root,
      options,
      { ...seams, interactive: options.application === "report-only" },
      () => {},
    );
    expect(rows(report).every((r) => !r.selected)).toBe(true);
    const after = await snapshot(root);
    for (const [path, bytes] of Object.entries(before))
      expect(after[path]).toBe(bytes);
  }
});

test("decline and interactive dry run offer all sections without changing any bytes", async () => {
  for (const dryRun of [false, true]) {
    const root = await project();
    const before = await snapshot(root);
    const confirm = vi.fn(async () => false);
    const report = await runWiring(
      root,
      { dryRun },
      { ...seams, confirm },
      () => {},
    );
    expect(rows(report).every((r) => r.selected)).toBe(true);
    expect(report.mode).toBe(dryRun ? "preview" : "declined");
    expect(confirm).toHaveBeenCalledTimes(dryRun ? 0 : 1);
    expect(await snapshot(root)).toEqual(before);
  }
});

test("individual skips and deselection win; missing roles are never created", async () => {
  for (const target of AUTOBUILD_SKILLS) {
    const root = await project();
    const original = await readFile(join(root, target.path), "utf8");
    await runWiring(
      root,
      { skipWiring: [target.surface] },
      { ...seams, confirm: async () => true },
      () => {},
    );
    expect(await readFile(join(root, target.path), "utf8")).toBe(original);
  }
  const root = await project();
  const target = AUTOBUILD_SKILLS[1];
  await rm(join(root, target.path));
  const report = await runWiring(
    root,
    {},
    {
      ...seams,
      confirm: async () => true,
      select: async () => ({
        selected: [AUTOBUILD_SKILLS[0].surface],
        nightly: false,
      }),
    },
    () => {},
  );
  expect(rows(report).map((r) => r.disposition)).toEqual([
    "update",
    "unavailable",
    "skipped",
  ]);
  await expect(lstat(join(root, target.path))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("removing sections is visible to selection and yes cannot resurrect them; old managed sections refresh", async () => {
  const root = await project();
  await runWiring(root, {}, { ...seams, confirm: async () => true }, () => {});
  for (const target of AUTOBUILD_SKILLS) {
    const source = await readFile(join(root, target.path), "utf8");
    const span = sectionSpan(source, markers(target.surface, "html"));
    if (!span) throw new Error("Expected managed section");
    await writeFile(
      join(root, target.path),
      source.slice(0, span.start) + source.slice(span.end + 1),
    );
  }
  const removed = await snapshot(root);
  const report = await runWiring(root, { yes: true }, seams, () => {});
  expect(rows(report).every((r) => !r.selected)).toBe(true);
  expect(await snapshot(root)).toEqual(removed);
  for (const target of AUTOBUILD_SKILLS) {
    const source = await readFile(join(root, target.path), "utf8");
    await writeFile(
      join(root, target.path),
      autobuildSkillWriter(source, target).candidate.replace(
        "## Idiom",
        "## Old Idiom",
      ),
    );
  }
  const refreshed = await runWiring(
    root,
    { yes: true, skipWiring: [AUTOBUILD_SKILLS[1].surface] },
    seams,
    () => {},
  );
  expect(rows(refreshed).map((r) => r.disposition)).toEqual([
    "update",
    "skipped",
    "update",
  ]);
});

test("changed or deleted targets abort the transaction; failed skill writes roll back", async () => {
  for (const deleted of [false, true]) {
    const root = await project();
    const before = await snapshot(root);
    const path = AUTOBUILD_SKILLS[1].path;
    await expect(
      runWiring(
        root,
        {},
        {
          ...seams,
          confirm: async () => {
            if (deleted) await rm(join(root, path));
            else await writeFile(join(root, path), "edited meanwhile");
            return true;
          },
        },
        () => {},
      ),
    ).rejects.toThrow(/changed/);
    expect(await readFile(join(root, AUTOBUILD_SKILLS[0].path), "utf8")).toBe(
      before[AUTOBUILD_SKILLS[0].path],
    );
    await expect(lstat(join(root, "AGENTS.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }
  const root = await project();
  const before = await snapshot(root);
  await expect(
    runWiring(
      root,
      {},
      {
        ...seams,
        confirm: async () => true,
        apply: {
          beforeRename: async (path) => {
            if (path === AUTOBUILD_SKILLS[1].path) throw new Error("disk full");
          },
        },
      },
      () => {},
    ),
  ).rejects.toThrow(/disk full/);
  expect(await snapshot(root)).toEqual(before);
});

test("unsafe paths and invalid skills are protected even when unselected", async () => {
  for (const kind of ["file-link", "ancestor-link", "identity", "markers"]) {
    const root = await project();
    const outside = await temporary();
    const target = AUTOBUILD_SKILLS[0];
    const original = await fixture(target.identity);
    if (kind === "file-link") {
      await writeFile(join(outside, "SKILL.md"), original);
      await rm(join(root, target.path));
      await symlink(join(outside, "SKILL.md"), join(root, target.path));
    } else if (kind === "ancestor-link") {
      await writeFile(join(outside, "SKILL.md"), original);
      await rm(dirname(join(root, target.path)), { recursive: true });
      await symlink(outside, dirname(join(root, target.path)));
    } else
      await writeFile(
        join(root, target.path),
        kind === "identity"
          ? "wrong identity"
          : original + markers(target.surface, "html")[0],
      );
    const before = await snapshot(root);
    const plan = await planWiring(root, {}, seams);
    expect(rows(plan)[0]?.disposition).toBe("protected");
    await runWiring(root, { yes: true }, seams, () => {});
    const after = await snapshot(root);
    for (const [path, bytes] of Object.entries(before))
      expect(after[path]).toBe(bytes);
    if (kind.endsWith("link"))
      expect(await readFile(join(outside, "SKILL.md"), "utf8")).toBe(original);
  }
});

test("init offers the roles through its single apply-wiring confirmation", async () => {
  const root = await project();
  await initProject({
    project: root,
    yes: true,
    wiringDependencies: seams,
    write: () => {},
  });
  const confirm = vi.fn(async (request) => {
    expect(request.kind).toBe("apply-wiring");
    return true;
  });
  const facts = await collectSetupFacts(root);
  for (const target of AUTOBUILD_SKILLS)
    expect(facts.wiring?.found).toContain(target.path);
  const result = await initProject({
    project: root,
    wiring: { wire: true },
    confirm,
    wiringDependencies: seams,
    write: () => {},
  });
  expect(confirm).toHaveBeenCalledTimes(1);
  if (!result.wiring) throw new Error("Expected wiring report");
  for (const target of AUTOBUILD_SKILLS)
    expect(wiringSummaryLines(result.wiring).join("\n")).toContain(
      `${target.surface}: wired`,
    );
  expect(
    result.wiring &&
      rows(result.wiring).every((r) => r.disposition === "update"),
  ).toBe(true);
});

test("a skill disappearing between detection and proposal is protected, never recreated", async () => {
  const root = await project();
  const target = AUTOBUILD_SKILLS[0];
  const plan = await planWiring(
    root,
    { offerAutobuildSkills: true },
    {
      ...seams,
      git: async () => {
        await rm(join(root, target.path), { force: true });
        throw new Error("not git");
      },
    },
  );
  expect(rows(plan)[0]?.disposition).toBe("protected");
  expect(plan.writes.some((w) => w.path === target.path)).toBe(false);
});
