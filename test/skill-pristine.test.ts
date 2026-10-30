import { readdir, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { initProject } from "../src/commands/init.js";
import { readHistory } from "../src/skills/distribution.js";
import { digest, manifestPath } from "../src/skills/pristine.js";
import { templatesDirectory } from "../src/templates.js";
import { IDIOM_VERSION } from "../src/version.js";
import { base, metadata, put, read, temporary, tree } from "./skill-support.js";

test("init records all installed bytes and version without inflating the original counts", async () => {
  const root = await temporary();
  const first = await initProject({ project: root, yes: true });
  expect(first.created).toHaveLength(11);
  const record = await metadata(root);
  expect(Object.keys(record.files).sort()).toEqual([
    "idiom/SKILL.md",
    "idiom/init.md",
  ]);
  for (const name of ["SKILL.md", "init.md"]) {
    const bytes = await read(root, `.agents/skills/idiom/${name}`);
    expect(await base(root, `idiom/${name}`)).toBe(bytes);
    expect(record.files[`idiom/${name}`]).toEqual({
      version: IDIOM_VERSION,
      digest: digest(bytes),
    });
  }
  const before = await tree(root);
  expect(
    (await initProject({ project: root, yes: true })).unchanged,
  ).toHaveLength(11);
  expect(await tree(root)).toEqual(before);
});
test("init never fabricates a baseline from customized bytes or refreshes older provenance", async () => {
  const root = await temporary();
  await initProject({ project: root, yes: true });
  const record = await metadata(root);
  record.files["idiom/SKILL.md"].version = "0.0.1";
  await put(root, manifestPath, JSON.stringify(record));
  const original = await read(root, manifestPath);
  await put(root, ".agents/skills/idiom/SKILL.md", "custom skill");
  await initProject({ project: root, yes: true });
  expect(await read(root, manifestPath)).toBe(original);
  const legacy = await temporary();
  await put(legacy, ".agents/skills/idiom/SKILL.md", "custom");
  await initProject({ project: legacy, yes: true });
  expect((await tree(legacy))[manifestPath]).toBeUndefined();
});
test("confirmed wiring and already-wired exact verifier seed pristine", async () => {
  const root = await temporary();
  await put(
    root,
    "autobuild.toml",
    '[commands]\ntest="true"\n[verify]\nsteps=["test"]\n[verify.test]\nkind="check"\ncommand="test"\n',
  );
  const result = await initProject({
    project: root,
    confirm: async (request) =>
      ["offer-autobuild-wiring", "apply-autobuild-config"].includes(
        request.kind,
      ),
    write: () => {},
  });
  expect(result.autobuild.kind).toBe("applied");
  expect(await base(root, "ab-verify-idiom/SKILL.md")).toBe(
    await read(root, ".agents/skills/ab-verify-idiom/SKILL.md"),
  );
  const { rm } = await import("node:fs/promises");
  await rm(join(root, ".agents/skills/.idiom-pristine"), { recursive: true });
  expect((await initProject({ project: root, yes: true })).autobuild.kind).toBe(
    "already-wired",
  );
  expect((await metadata(root)).files["ab-verify-idiom/SKILL.md"].version).toBe(
    IDIOM_VERSION,
  );
});
test.each([".agents", ".agents/skills/.idiom-pristine"])(
  "init does not follow %s symlinks",
  async (path) => {
    const root = await temporary();
    const outside = await temporary();
    await put(outside, "sentinel", "unchanged");
    if (path.includes(".idiom-pristine")) {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(join(root, ".agents/skills"), { recursive: true });
    }
    await symlink(outside, join(root, path));
    const before = await tree(outside);
    await initProject({ project: root, yes: true });
    expect(await tree(outside)).toEqual(before);
  },
);
test("offline catalog blobs have exact digests, tag provenance and absence-aware file maps", async () => {
  const history = await readHistory();
  expect(history.schema).toBe(1);
  expect(history.releases).toHaveLength(19);
  expect(history.releases[0]).toMatchObject({
    version: "0.0.1",
    tag: "v0.0.1",
  });
  expect(history.releases.at(-1)?.version).toBe("0.16.0");
  const blobs = new Set<string>();
  for (const release of history.releases) {
    expect(release.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(release.tagObject).toMatch(/^[a-f0-9]{40}$/);
    for (const hash of Object.values(release.files)) {
      const content = await readFile(
        join(templatesDirectory(), "skill-history/blobs", `${hash}.md`),
        "utf8",
      );
      expect(digest(content)).toBe(hash);
      blobs.add(`${hash}.md`);
    }
  }
  expect(
    new Set(await readdir(join(templatesDirectory(), "skill-history/blobs"))),
  ).toEqual(blobs);
  expect(
    history.releases[0]?.files["ab-verify-idiom/SKILL.md"],
  ).toBeUndefined();
  expect(
    history.releases.at(-1)?.files["ab-verify-idiom/SKILL.md"],
  ).toBeDefined();
  // Pinned fixture from v0.0.1; protects against cataloguing today's bytes as history.
  expect(history.releases[0]?.files["idiom/SKILL.md"]).toBe(
    "e0de111da6a429fb795b56e52d768b022bea2983983e9283f4879b2cf4469f82",
  );
});

test("init preserves foreign verifier identity and symlinked discovery ancestors", async () => {
  const root = await temporary();
  const outside = await temporary();
  await put(
    root,
    "autobuild.toml",
    '[commands]\ntest="true"\n[verify]\nsteps=["test"]\n[verify.test]\nkind="check"\ncommand="test"\n',
  );
  const { skill } = await import("./skill-support.js");
  await put(
    root,
    ".agents/skills/ab-verify-idiom/SKILL.md",
    skill("foreign\n", "someone-else"),
  );
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(root, ".claude"));
  await symlink(outside, join(root, ".claude/skills"));
  await put(outside, "sentinel", "private");
  const before = await tree(outside);
  const result = await initProject({
    project: root,
    confirm: async (request) => request.kind === "offer-autobuild-wiring",
    write: () => {},
  });
  expect(result.autobuild.kind).toBe("manual");
  expect(await tree(outside)).toEqual(before);
  expect(await read(root, ".agents/skills/ab-verify-idiom/SKILL.md")).toContain(
    "someone-else",
  );
});

test("a protected Idiom canonical directory cannot block pristine records for an approved verifier", async () => {
  const root = await temporary();
  const outside = await temporary();
  await put(outside, "SKILL.md", "foreign sentinel");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(root, ".agents/skills"), { recursive: true });
  await symlink(outside, join(root, ".agents/skills/idiom"));
  await put(
    root,
    "autobuild.toml",
    '[commands]\ntest="true"\n[verify]\nsteps=["test"]\n[verify.test]\nkind="check"\ncommand="test"\n',
  );
  const result = await initProject({
    project: root,
    confirm: async (request) =>
      ["offer-autobuild-wiring", "apply-autobuild-config"].includes(
        request.kind,
      ),
    write: () => {},
  });
  expect(result.autobuild.kind).toBe("applied");
  expect((await metadata(root)).files["ab-verify-idiom/SKILL.md"].version).toBe(
    IDIOM_VERSION,
  );
  expect(await read(outside, "SKILL.md")).toBe("foreign sentinel");
});

test("protected pristine bookkeeping reports separately without inflating init result counts", async () => {
  const root = await temporary();
  const outside = await temporary();
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(root, ".agents/skills"), { recursive: true });
  await symlink(outside, join(root, ".agents/skills/.idiom-pristine"));
  const result = await initProject({ project: root, yes: true });
  expect(result.created).toHaveLength(11);
  expect(result.skipped).toEqual([]);
  expect(result.skillWarnings).toHaveLength(1);
  const { initSummaryLines } = await import("../src/commands/init.js");
  expect(initSummaryLines(result).join("\n")).toContain(
    "Pristine records for idiom could not be seeded",
  );
});
