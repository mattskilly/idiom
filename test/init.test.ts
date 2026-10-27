import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  type InitConfirmationRequest,
  initProject,
} from "../src/commands/init.js";
import { projectSchema } from "../src/schemas/project.js";
import {
  idiomSkillFileNames,
  readAutobuildTemplate,
  readAutobuildVerifierSkillTemplate,
  readIdiomSkillFile,
  readIdiomSkillTemplate,
  readTemplate,
  templateNames,
  templatesDirectory,
} from "../src/templates.js";

const temporaryDirectories: string[] = [];

async function temporaryProject(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "idiom-init-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("first run creates the complete scaffold with schema-valid defaults", async () => {
  const project = await temporaryProject();
  const result = await initProject({ project, yes: true });
  expect(result.created).toHaveLength(11);
  expect(await readFile(join(project, ".idiom", ".gitignore"), "utf8")).toBe(
    "reports/\n/agent-hooks/\n",
  );
  for (const directory of [
    "flows",
    "references",
    "anti-references",
    "reports",
  ]) {
    expect(
      await readFile(join(project, ".idiom", ".gitignore"), "utf8"),
    ).toBeDefined();
    const stat = await import("node:fs/promises").then(({ stat }) =>
      stat(join(project, ".idiom", directory)),
    );
    expect(stat.isDirectory()).toBe(true);
  }
  const parsed = projectSchema.parse(
    JSON.parse(await readFile(join(project, ".idiom", "project.json"), "utf8")),
  );
  expect(parsed.app.name).toBe(basename(project));
  expect(parsed.model.provider).toBe("claude-code");
  expect(
    JSON.parse(
      await readFile(join(project, ".idiom", "finding-names.json"), "utf8"),
    ),
  ).toEqual({ version: 1, next: 1, entries: [] });
  expect(
    JSON.parse(
      await readFile(join(project, ".idiom", "ruling-names.json"), "utf8"),
    ),
  ).toEqual({ version: 1, next: 1, entries: [] });
  for (const name of idiomSkillFileNames) {
    expect(
      await readFile(join(project, ".agents", "skills", "idiom", name), "utf8"),
      name,
    ).toBe(await readIdiomSkillFile(name));
  }
  const claudeSkill = join(project, ".claude", "skills", "idiom");
  expect((await lstat(claudeSkill)).isSymbolicLink()).toBe(true);
  expect(await readlink(claudeSkill)).toBe("../../.agents/skills/idiom");
  expect(await readFile(join(claudeSkill, "SKILL.md"), "utf8")).toBe(
    await readIdiomSkillTemplate(),
  );
});

test("a second non-interactive run is byte-identical", async () => {
  const project = await temporaryProject();
  await initProject({ project, yes: true });
  const files = [
    "PRODUCT.md",
    "DESIGN.md",
    ".idiom/project.json",
    ".idiom/rules.json",
    ".idiom/decisions.jsonl",
    ".idiom/finding-names.json",
    ".idiom/ruling-names.json",
    ".idiom/.gitignore",
    ".agents/skills/idiom/SKILL.md",
    ".agents/skills/idiom/init.md",
  ];
  const before = await Promise.all(
    files.map((file) => readFile(join(project, file))),
  );
  const second = await initProject({ project, yes: true });
  const after = await Promise.all(
    files.map((file) => readFile(join(project, file))),
  );
  expect(after).toEqual(before);
  expect(second.created).toEqual([]);
  expect(second.skipped).toEqual([]);
  expect(second.unchanged).toHaveLength(11);
  expect(await readlink(join(project, ".claude", "skills", "idiom"))).toBe(
    "../../.agents/skills/idiom",
  );
});

test("--yes and a declined prompt preserve sentinel bytes", async () => {
  const project = await temporaryProject();
  await initProject({ project, yes: true });
  const product = join(project, "PRODUCT.md");
  await writeFile(product, "sentinel\0bytes", "utf8");

  const nonInteractive = await initProject({ project, yes: true });
  expect(nonInteractive.skipped).toContain("PRODUCT.md");
  expect(await readFile(product, "utf8")).toBe("sentinel\0bytes");

  const confirm = vi.fn(async () => false);
  await initProject({ project, confirm });
  expect(confirm).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "replace-scaffold-file",
      path: "PRODUCT.md",
    }),
  );
  expect(await readFile(product, "utf8")).toBe("sentinel\0bytes");
});

test("only an affirmative per-file confirmation replaces differing content", async () => {
  const project = await temporaryProject();
  await initProject({ project, yes: true });
  const design = join(project, "DESIGN.md");
  await writeFile(design, "replace me", "utf8");
  const result = await initProject({
    project,
    confirm: async (request) => request.path === "DESIGN.md",
  });
  expect(result.replaced).toEqual(["DESIGN.md"]);
  expect(await readFile(design, "utf8")).toBe(await readTemplate("DESIGN.md"));
});

test("all package templates resolve through the source/package-relative seam", async () => {
  expect(templatesDirectory()).toBe(
    join(import.meta.dirname, "..", "templates"),
  );
  for (const name of templateNames)
    await expect(readTemplate(name)).resolves.toBeTypeOf("string");
  await expect(readIdiomSkillTemplate()).resolves.toContain("name: idiom");
  for (const name of idiomSkillFileNames)
    await expect(readIdiomSkillFile(name)).resolves.toBeTypeOf("string");
});

test("init preserves sibling skills", async () => {
  const project = await temporaryProject();
  const sibling = join(project, ".agents", "skills", "existing", "SKILL.md");
  await mkdir(join(sibling, ".."), { recursive: true });
  await writeFile(sibling, "sibling bytes", "utf8");

  await initProject({ project, yes: true });

  expect(await readFile(sibling, "utf8")).toBe("sibling bytes");
});

test("an owned skill directory gains a managed file it is missing", async () => {
  const project = await temporaryProject();
  await initProject({ project, yes: true });
  const guide = join(project, ".agents", "skills", "idiom", "init.md");
  await rm(guide);

  const result = await initProject({ project, yes: true });

  expect(result.created).toEqual([".agents/skills/idiom/init.md"]);
  expect(result.unchanged).toContain(".agents/skills/idiom/SKILL.md");
  expect(await readFile(guide, "utf8")).toBe(
    await readIdiomSkillFile("init.md"),
  );
});

test("a modified managed skill file is preserved beside an owned SKILL.md", async () => {
  const project = await temporaryProject();
  await initProject({ project, yes: true });
  const guide = join(project, ".agents", "skills", "idiom", "init.md");
  await writeFile(guide, "local interview", "utf8");

  const result = await initProject({ project, yes: true });

  expect(result.skipped).toEqual([".agents/skills/idiom/init.md"]);
  expect(await readFile(guide, "utf8")).toBe("local interview");
  expect(result.unchanged).toContain(".claude/skills/idiom");
  expect(await readlink(join(project, ".claude", "skills", "idiom"))).toBe(
    "../../.agents/skills/idiom",
  );
});

test("a custom canonical skill is preserved without prompting or a Claude link", async () => {
  for (const yes of [true, false]) {
    const project = await temporaryProject();
    const canonical = join(project, ".agents", "skills", "idiom");
    await mkdir(canonical, { recursive: true });
    await writeFile(join(canonical, "SKILL.md"), "custom skill", "utf8");
    const confirm = vi.fn(
      async (request: InitConfirmationRequest) =>
        request.kind !== "offer-flow-generation",
    );

    const result = await initProject({ project, yes, confirm });

    expect(result.skipped).toContain(".agents/skills/idiom/SKILL.md");
    expect(await readFile(join(canonical, "SKILL.md"), "utf8")).toBe(
      "custom skill",
    );
    await expect(lstat(join(canonical, "init.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    for (const paths of [
      result.created,
      result.replaced,
      result.unchanged,
      result.skipped,
    ])
      expect(paths).not.toContain(".agents/skills/idiom/init.md");
    await expect(
      lstat(join(project, ".claude", "skills", "idiom")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(confirm).toHaveBeenCalledTimes(yes ? 0 : 1);
  }
});

test("foreign and broken Claude skill symlinks are preserved", async () => {
  const project = await temporaryProject();
  await initProject({ project, yes: true });
  const claudeSkill = join(project, ".claude", "skills", "idiom");
  await rm(claudeSkill);
  await symlink("../../missing/foreign-skill", claudeSkill, "dir");

  const result = await initProject({ project, yes: true });

  expect(result.skipped).toContain(".claude/skills/idiom");
  expect(await readlink(claudeSkill)).toBe("../../missing/foreign-skill");
});

test.each(["file", "directory", "symlink"])(
  "a canonical %s occupant is preserved",
  async (kind) => {
    const project = await temporaryProject();
    const canonical = join(project, ".agents", "skills", "idiom");
    await mkdir(join(canonical, ".."), { recursive: true });
    if (kind === "file") await writeFile(canonical, "occupant", "utf8");
    else if (kind === "directory") await mkdir(canonical);
    else await symlink("../../../missing-skill", canonical, "dir");

    const result = await initProject({ project, yes: true });

    expect(result.skipped).toContain(".agents/skills/idiom/SKILL.md");
    const entry = await lstat(canonical);
    expect(
      kind === "file"
        ? entry.isFile()
        : kind === "directory"
          ? entry.isDirectory()
          : entry.isSymbolicLink(),
    ).toBe(true);
  },
);

test.each(["file", "directory"])(
  "a Claude %s occupant is preserved",
  async (kind) => {
    const project = await temporaryProject();
    await initProject({ project, yes: true });
    const claudeSkill = join(project, ".claude", "skills", "idiom");
    await rm(claudeSkill);
    if (kind === "file") await writeFile(claudeSkill, "occupant", "utf8");
    else await mkdir(claudeSkill);

    const result = await initProject({ project, yes: true });

    expect(result.skipped).toContain(".claude/skills/idiom");
    const entry = await lstat(claudeSkill);
    expect(kind === "file" ? entry.isFile() : entry.isDirectory()).toBe(true);
  },
);

test("Autobuild verification assets ship as templates but are not init scaffolding", async () => {
  const templates = templatesDirectory();
  await expect(
    readFile(join(templates, "ab-verify-idiom", "SKILL.md"), "utf8"),
  ).resolves.toContain("idiom verify booking");
  await expect(
    readFile(join(templates, "autobuild.idiom.toml"), "utf8"),
  ).resolves.toContain("[verify.idiom]");

  const project = await temporaryProject();
  await initProject({ project, yes: true });
  await expect(
    readFile(join(project, ".agents", "skills", "ab-verify-idiom", "SKILL.md")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await expect(
    readFile(join(project, "autobuild.idiom.toml")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

test("declining the Autobuild offer leaves every wiring destination untouched", async () => {
  const project = await temporaryProject();
  const config = join(project, "autobuild.toml");
  await writeFile(config, '[verify]\nsteps = ["test"]\n', "utf8");
  const confirm = vi.fn(async () => false);

  const result = await initProject({ project, confirm });

  expect(result.autobuild).toEqual({ kind: "declined" });
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(confirm).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "offer-autobuild-wiring" }),
  );
  expect(await readFile(config, "utf8")).toBe('[verify]\nsteps = ["test"]\n');
  await expect(
    lstat(join(project, ".agents", "skills", "ab-verify-idiom")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await expect(
    lstat(join(project, ".claude", "skills", "ab-verify-idiom")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(result.created).toContain("PRODUCT.md");
});

test("--yes only reports interactive Autobuild availability", async () => {
  const project = await temporaryProject();
  await writeFile(join(project, "autobuild.toml"), "[project]\nname='x'\n");
  const confirm = vi.fn(
    async (request: InitConfirmationRequest) =>
      request.kind !== "offer-flow-generation",
  );

  const result = await initProject({ project, yes: true, confirm });

  expect(result.autobuild).toEqual({ kind: "available-noninteractive" });
  expect(confirm).not.toHaveBeenCalled();
  expect(await readFile(join(project, "autobuild.toml"), "utf8")).toBe(
    "[project]\nname='x'\n",
  );
});

test("accepted wiring previews before config consent and writes all canonical entries", async () => {
  const project = await temporaryProject();
  const config = join(project, "autobuild.toml");
  const original = '[verify]\nsteps = ["test"]\n';
  await writeFile(config, original);
  const events: string[] = [];
  let preview = "";

  const result = await initProject({
    project,
    write: (message) => {
      preview = message;
      events.push("diff");
    },
    confirm: async (request) => {
      if (request.kind === "offer-flow-generation") return false;
      events.push(request.kind);
      if (request.kind === "apply-autobuild-config") {
        expect(request.diff).toBe(preview);
        expect(await readFile(config, "utf8")).toBe(original);
      }
      return true;
    },
  });

  expect(events).toEqual([
    "offer-autobuild-wiring",
    "diff",
    "apply-autobuild-config",
  ]);
  expect(result.autobuild).toEqual({ kind: "applied" });
  expect(await readFile(config, "utf8")).toContain('steps = ["test", "idiom"]');
  expect(
    await readFile(
      join(project, ".agents", "skills", "ab-verify-idiom", "SKILL.md"),
      "utf8",
    ),
  ).toBe(await readAutobuildVerifierSkillTemplate());
  expect(
    await readlink(join(project, ".claude", "skills", "ab-verify-idiom")),
  ).toBe("../../.agents/skills/ab-verify-idiom");
});

test("fully wired pathless reruns do not prompt or duplicate custom compatible wiring", async () => {
  const project = await temporaryProject();
  await writeFile(
    join(project, "autobuild.toml"),
    `[commands]\nidiom-verify = "idiom verify home --spec .ab/spec.md --out .ab/idiom"\n[verify]\nsteps = ["idiom"]\n[verify.idiom]\nkind = "agent"\nskill = "ab-verify-idiom"\nalways = true\n`,
  );
  await mkdir(join(project, ".agents", "skills", "ab-verify-idiom"), {
    recursive: true,
  });
  await writeFile(
    join(project, ".agents", "skills", "ab-verify-idiom", "SKILL.md"),
    await readAutobuildVerifierSkillTemplate(),
  );
  await mkdir(join(project, ".claude", "skills"), { recursive: true });
  await symlink(
    "../../.agents/skills/ab-verify-idiom",
    join(project, ".claude", "skills", "ab-verify-idiom"),
    "dir",
  );
  const confirm = vi.fn(
    async (request: InitConfirmationRequest) =>
      request.kind !== "offer-flow-generation",
  );

  const result = await initProject({ project, confirm });

  expect(result.autobuild).toEqual({ kind: "already-wired" });
  expect(confirm).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "offer-flow-generation" }),
  );
  expect(
    (await readFile(join(project, "autobuild.toml"), "utf8")).match(
      /idiom-verify/g,
    ),
  ).toHaveLength(1);
});

test("declining a differing verifier replacement rolls back the whole wiring decision", async () => {
  const project = await temporaryProject();
  const config = join(project, "autobuild.toml");
  const original = "[project]\nname = 'x'\n";
  await writeFile(config, original);
  const skill = join(
    project,
    ".agents",
    "skills",
    "ab-verify-idiom",
    "SKILL.md",
  );
  await mkdir(join(skill, ".."), { recursive: true });
  await writeFile(skill, "custom verifier");

  const result = await initProject({
    project,
    write: () => undefined,
    confirm: async (request) =>
      request.kind !== "replace-autobuild-skill" &&
      request.kind !== "offer-flow-generation",
  });

  expect(result.autobuild).toEqual({ kind: "declined" });
  expect(await readFile(config, "utf8")).toBe(original);
  expect(await readFile(skill, "utf8")).toBe("custom verifier");
  await expect(
    lstat(join(project, ".claude", "skills", "ab-verify-idiom")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

test("unsafe Autobuild TOML returns the exact manual template and still scaffolds", async () => {
  const project = await temporaryProject();
  await writeFile(join(project, "autobuild.toml"), "invalid = [");

  const result = await initProject({
    project,
    confirm: async (request) => request.kind !== "offer-flow-generation",
  });

  expect(result.autobuild.kind).toBe("manual");
  if (result.autobuild.kind !== "manual") throw new Error("expected manual");
  expect(result.autobuild.addition).toBe(await readAutobuildTemplate());
  expect(await readFile(join(project, "autobuild.toml"), "utf8")).toBe(
    "invalid = [",
  );
  expect(await readFile(join(project, "PRODUCT.md"), "utf8")).toBe(
    await readTemplate("PRODUCT.md"),
  );
});

test("directory names containing replacement tokens remain valid app names", async () => {
  const parent = await temporaryProject();
  const project = join(parent, "app$&-$`-$'-$1-$$");
  await initProject({ project, yes: true });
  const parsed = projectSchema.parse(
    JSON.parse(await readFile(join(project, ".idiom", "project.json"), "utf8")),
  );
  expect(parsed.app.name).toBe("app$&-$`-$'-$1-$$");
});
