import { chmod, lstat, readlink, symlink } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { readDistribution, readHistory } from "../src/skills/distribution.js";
import { digest, manifestPath, pristinePath } from "../src/skills/pristine.js";
import { upgradeSkills } from "../src/skills/upgrade.js";
import {
  base,
  distribution,
  metadata,
  put,
  read,
  runUpgrade,
  skill,
  temporary,
  tree,
} from "./skill-support.js";

const live = ".agents/skills/idiom/SKILL.md";
const aux = ".agents/skills/idiom/init.md";
const files = (body: string, init = "a\nb\nc\nd\ne\nf\ng\n") => ({
  "SKILL.md": skill(body),
  "init.md": init,
});
const original = "alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\n";

test("install, pristine provenance, true second-run no-op and lazy provider", async () => {
  const root = await temporary();
  const createResolver = vi.fn(() => {
    throw new Error("must be lazy");
  });
  expect(
    (await runUpgrade(root, undefined, {}, { createResolver })).files.map(
      (file) => file.action,
    ),
  ).toEqual(["installed", "installed"]);
  expect(await base(root)).toBe(skill());
  expect((await metadata(root)).files["idiom/SKILL.md"]).toEqual({
    version: "1.0.0",
    digest: digest(skill()),
  });
  expect(await readlink(join(root, ".claude/skills/idiom"))).toBe(
    "../../.agents/skills/idiom",
  );
  const snapshot = await tree(root);
  expect(
    (await runUpgrade(root, undefined, {}, { createResolver })).files.every(
      (file) => file.action === "current",
    ),
  ).toBe(true);
  expect(await tree(root)).toEqual(snapshot);
  expect(createResolver).not.toHaveBeenCalled();
});

test("adopts old untouched files and restores missing tracked files", async () => {
  const root = await temporary();
  await runUpgrade(root);
  const next = distribution(
    "2.0.0",
    files(original.replace("zeta", "upstream")),
  );
  expect((await runUpgrade(root, next)).files[0]?.action).toBe("adopted");
  expect(await base(root)).toBe(next.skills.idiom?.["SKILL.md"]?.content);
  const { rm } = await import("node:fs/promises");
  await rm(join(root, live));
  expect((await runUpgrade(root, next)).files[0]?.action).toBe("adopted");
});

test("three releases, identical upstream, permissions, and rollback retain customization", async () => {
  const root = await temporary();
  await runUpgrade(root);
  await put(root, live, skill(original.replace("alpha", "local")));
  await chmod(join(root, live), 0o640);
  const second = distribution(
    "2.0.0",
    files(original.replace("zeta", "upstream")),
  );
  expect((await runUpgrade(root, second)).files[0]?.action).toBe("merged");
  expect(await read(root, live)).toBe(
    skill(original.replace("alpha", "local").replace("zeta", "upstream")),
  );
  expect(await base(root)).toBe(second.skills.idiom?.["SKILL.md"]?.content);
  expect((await lstat(join(root, live))).mode & 0o777).toBe(0o640);
  const snapshot = await tree(root);
  expect((await runUpgrade(root, second)).files[0]?.action).toBe("current");
  expect(await tree(root)).toEqual(snapshot);
  const third = distribution(
    "3.0.0",
    files(original.replace("epsilon", "new").replace("zeta", "upstream")),
  );
  expect((await runUpgrade(root, third)).files[0]?.action).toBe("merged");
  expect(await read(root, live)).toContain("local\n");
  expect((await runUpgrade(root, distribution("1.0.0"))).files[0]?.action).toBe(
    "merged",
  );
  expect(await read(root, live)).toBe(
    skill(original.replace("alpha", "local")),
  );
  expect(await base(root)).toBe(skill());
  expect((await runUpgrade(root, distribution("1.0.1"))).files[0]?.action).toBe(
    "current",
  );
  expect((await metadata(root)).files["idiom/SKILL.md"].version).toBe("1.0.1");
});

test("upstream additions, removals, kept local extras and rollback restore support", async () => {
  const root = await temporary();
  await runUpgrade(root);
  await put(root, ".agents/skills/idiom/local.md", "extra");
  const next = distribution("2.0.0", { "SKILL.md": skill(), "new.md": "new" });
  const report = await runUpgrade(root, next);
  expect(report.files.map((file) => file.action)).toEqual([
    "current",
    "removed",
    "installed",
  ]);
  expect((await tree(root))[aux]).toBeUndefined();
  expect((await metadata(root)).files["idiom/init.md"]).toBeUndefined();
  expect(
    (await runUpgrade(root, distribution("1.0.0"))).files.map(
      (file) => file.action,
    ),
  ).toEqual(["current", "installed", "removed"]);
  await put(root, aux, "custom");
  expect(
    (await runUpgrade(root, next)).files.find((file) => file.path === aux)
      ?.action,
  ).toBe("kept");
  expect(await read(root, aux)).toBe("custom");
  expect(
    (await runUpgrade(root, next)).files.some((file) => file.path === aux),
  ).toBe(false);
  expect(await read(root, ".agents/skills/idiom/local.md")).toBe("extra");
});

test("valid hunk resolution preserves clean upstream bytes and incoming baseline", async () => {
  const root = await temporary();
  await runUpgrade(root);
  await put(root, live, skill(original.replace("alpha", "custom")));
  const incoming = distribution(
    "2.0.0",
    files(original.replace("alpha", "release").replace("zeta", "upstream")),
  );
  const resolve = vi.fn(async (input) => ({
    decision: "resolve",
    replacements: input.merge.conflicts.map(
      (conflict: { id: string; local: string }) => ({
        id: conflict.id,
        text: conflict.local,
      }),
    ),
    reason: "Preserve customization",
  }));
  const report = await runUpgrade(
    root,
    incoming,
    {},
    { createResolver: () => resolve },
  );
  expect(report.files[0]?.action).toBe("resolved");
  expect(await read(root, live)).toBe(
    skill(original.replace("alpha", "custom").replace("zeta", "upstream")),
  );
  expect(await base(root)).toBe(incoming.skills.idiom?.["SKILL.md"]?.content);
  expect(resolve).toHaveBeenCalledOnce();
});

test.each([
  "no-agent",
  "dry-run",
  "throws",
  "declines",
  "invalid",
  "missing-git",
])("%s preserves a conflict and advances safe neighbors", async (mode) => {
  const root = await temporary();
  await runUpgrade(root);
  await put(root, live, skill(original.replace("alpha", "custom")));
  const before = await tree(root);
  const resolver = vi.fn(async () => {
    if (mode === "throws") throw new Error("unavailable");
    return {
      decision: mode === "declines" ? "decline" : "resolve",
      replacements: [],
      reason: "ambiguous",
    };
  });
  const createResolver = vi.fn(() => resolver);
  const report = await runUpgrade(
    root,
    distribution(
      "2.0.0",
      files(original.replace("alpha", "release"), "updated"),
    ),
    { agent: mode !== "no-agent", dryRun: mode === "dry-run" },
    {
      createResolver,
      ...(mode === "missing-git"
        ? {
            mergeRunner: async () => {
              throw new Error("spawn git ENOENT");
            },
          }
        : {}),
    },
  );
  expect(report.files[0]?.action).toBe("conflicted");
  expect(await read(root, live)).toBe(
    skill(original.replace("alpha", "custom")),
  );
  expect(await base(root)).toBe(skill());
  expect((await metadata(root)).files["idiom/SKILL.md"].version).toBe("1.0.0");
  if (mode === "dry-run") expect(await tree(root)).toEqual(before);
  else {
    expect(await read(root, aux)).toBe("updated");
    expect(report.files[1]?.action).toBe("adopted");
  }
  if (["no-agent", "dry-run", "missing-git"].includes(mode))
    expect(createResolver).not.toHaveBeenCalled();
});

test("destination edited while resolving is not overwritten", async () => {
  const root = await temporary();
  await runUpgrade(root);
  await put(root, aux, "custom");
  const originalBaseline = await base(root, "idiom/init.md");
  const report = await runUpgrade(
    root,
    distribution("2.0.0", { "SKILL.md": skill(), "init.md": "upstream" }),
    {},
    {
      createResolver: () => async (input) => {
        await put(root, aux, "concurrent edit");
        return {
          decision: "resolve",
          replacements: input.merge.conflicts.map((hunk) => ({
            id: hunk.id,
            text: hunk.local,
          })),
          reason: "local",
        };
      },
    },
  );
  expect(report.files[1]?.action).toBe("conflicted");
  expect(await read(root, aux)).toBe("concurrent edit");
  expect(await base(root, "idiom/init.md")).toBe(originalBaseline);
});

test("ordinary write failure rolls back live, pristine and metadata; other files advance", async () => {
  const root = await temporary();
  await runUpgrade(root);
  const incoming = distribution(
    "2.0.0",
    files(original.replace("zeta", "updated"), "updated aux"),
  );
  const report = await runUpgrade(
    root,
    incoming,
    {},
    {
      apply: {
        beforeRename: async (path) => {
          if (path === pristinePath("idiom/SKILL.md"))
            throw new Error("injected write failure");
        },
      },
    },
  );
  expect(report.files.map((file) => file.action)).toEqual([
    "conflicted",
    "adopted",
  ]);
  expect(await read(root, live)).toBe(skill());
  expect(await base(root)).toBe(skill());
  expect((await metadata(root)).files["idiom/SKILL.md"].version).toBe("1.0.0");
  expect(
    Object.keys(await tree(root)).filter((path) => path.endsWith(".tmp")),
  ).toEqual([]);
});

test.each([
  "canonical",
  "support",
  "ancestor",
  "pristine",
  "manifest",
  "nested",
])(
  "protects %s symlinks without touching external targets",
  async (location) => {
    const root = await temporary();
    const external = await temporary();
    await runUpgrade(root);
    await put(external, "sentinel", "outside");
    const { rm } = await import("node:fs/promises");
    const path = {
      canonical: ".agents/skills/idiom",
      support: aux,
      ancestor: ".agents",
      pristine: ".agents/skills/.idiom-pristine",
      manifest: manifestPath,
      nested: ".agents/skills/idiom/nested",
    }[location] as string;
    await rm(join(root, path), { recursive: true, force: true });
    await symlink(
      location === "support" || location === "manifest"
        ? join(external, "sentinel")
        : external,
      join(root, path),
    );
    const before = await tree(external);
    const incoming = distribution("2.0.0", {
      "SKILL.md": skill(),
      "init.md": "updated",
      "nested/new.md": "new",
    });
    const report = await runUpgrade(root, incoming);
    expect(
      report.files.some(
        (file) => file.action === "kept" || file.action === "conflicted",
      ),
    ).toBe(true);
    expect(await tree(external)).toEqual(before);
    expect((await lstat(join(root, path))).isSymbolicLink()).toBe(true);
  },
);

test.each(["symlink", "directory", "file"])(
  "foreign discovery %s remains exact while canonical files advance",
  async (kind) => {
    const root = await temporary();
    await runUpgrade(root);
    const path = ".claude/skills/idiom";
    const { rm, mkdir } = await import("node:fs/promises");
    await rm(join(root, path));
    if (kind === "symlink")
      await symlink("../../my-own/../skill", join(root, path));
    else if (kind === "directory") {
      await mkdir(join(root, path));
      await put(root, `${path}/local`, "private");
    } else await put(root, path, "private");
    const before = (await tree(root))[path];
    const report = await runUpgrade(
      root,
      distribution("2.0.0", files(original.replace("zeta", "updated"))),
    );
    expect(report.discoveryConflicts).toHaveLength(1);
    expect(report.files[0]?.action).toBe("adopted");
    expect((await tree(root))[path]).toBe(before);
  },
);

test("foreign identity and unknown legacy bytes remain protected; no resolver guesses a base", async () => {
  const root = await temporary();
  await put(root, live, skill("foreign\n", "someone-else"));
  await put(root, aux, "private");
  const before = await tree(root);
  const createResolver = vi.fn();
  expect(
    (await runUpgrade(root, undefined, {}, { createResolver })).files.every(
      (file) => file.action === "kept",
    ),
  ).toBe(true);
  expect(await tree(root)).toEqual(before);
  await put(root, live, skill("my customization\n"));
  expect(
    (await runUpgrade(root, undefined, {}, { createResolver })).files.every(
      (file) => file.action === "conflicted",
    ),
  ).toBe(true);
  expect(createResolver).not.toHaveBeenCalled();
});

test("real offline history adopts legacy copies and reports honest candidate releases", async () => {
  const history = await readHistory();
  const incoming = await readDistribution();
  const root = await temporary();
  const release = history.releases[0];
  expect(release?.version).toBe("0.0.1");
  for (const [key, hash] of Object.entries(release?.files ?? {})) {
    const { templatesDirectory } = await import("../src/templates.js");
    const { readFile } = await import("node:fs/promises");
    const bytes = await readFile(
      join(templatesDirectory(), "skill-history/blobs", `${hash}.md`),
      "utf8",
    );
    await put(root, `.agents/skills/${key}`, bytes);
  }
  const report = await upgradeSkills(
    { projectDirectory: root, agent: false },
    { distribution: incoming, history },
  );
  expect(
    report.files.every((file) => ["adopted", "current"].includes(file.action)),
  ).toBe(true);
  expect(report.files.some((file) => file.previous.kind === "candidates")).toBe(
    true,
  );
  expect(report.files.some((file) => file.skill === "ab-verify-idiom")).toBe(
    false,
  );
});

test("verifier is opt-in, tracked missing verifier restores, both skills merge", async () => {
  const root = await temporary();
  const dist = distribution("1.0.0");
  const verifier = distribution(
    "1.0.0",
    { "SKILL.md": skill(original, "ab-verify-idiom") },
    "ab-verify-idiom",
  );
  dist.skills["ab-verify-idiom"] = verifier.skills["ab-verify-idiom"] ?? {};
  await put(root, "autobuild.toml", "detected=true");
  expect((await runUpgrade(root, dist)).files).toHaveLength(2);
  await put(
    root,
    ".agents/skills/ab-verify-idiom/SKILL.md",
    skill(original, "ab-verify-idiom"),
  );
  await runUpgrade(root, dist);
  const { rm } = await import("node:fs/promises");
  await rm(join(root, ".agents/skills/ab-verify-idiom"), { recursive: true });
  expect(
    (await runUpgrade(root, dist)).files.find(
      (file) => file.skill === "ab-verify-idiom",
    )?.action,
  ).toBe("adopted");
});

test("dry run on an empty project writes no directories, manifest or links and predicts actual actions", async () => {
  const root = await temporary();
  const before = await tree(root);
  const dry = await runUpgrade(root, undefined, { dryRun: true });
  expect(await tree(root)).toEqual(before);
  expect((await runUpgrade(root)).files).toEqual(dry.files);
});

test.each(["schema", "digest", "traversal", "orphan"])(
  "invalid %s provenance is preserved",
  async (kind) => {
    const root = await temporary();
    await runUpgrade(root);
    const record = await metadata(root);
    if (kind === "schema") record.schema = 999;
    if (kind === "digest")
      record.files["idiom/SKILL.md"].digest = "0".repeat(64);
    if (kind === "traversal")
      record.files["idiom/../../escape"] = record.files["idiom/SKILL.md"];
    if (kind === "orphan") delete record.files["idiom/SKILL.md"];
    await put(root, manifestPath, JSON.stringify(record));
    const before = await tree(root);
    const report = await runUpgrade(
      root,
      distribution("2.0.0", files("updated\n")),
    );
    expect(report.files[0]?.action).toBe("conflicted");
    expect(await read(root, live)).toBe(skill());
    if (["schema", "traversal"].includes(kind))
      expect(await read(root, manifestPath)).toBe(
        before[manifestPath]?.slice(5),
      );
    else
      expect((await metadata(root)).files["idiom/SKILL.md"]).toEqual(
        record.files["idiom/SKILL.md"],
      );
  },
);

test("new upstream support-file collisions preserve unknown local bytes", async () => {
  const root = await temporary();
  await runUpgrade(root);
  await put(root, ".agents/skills/idiom/new.md", "user-owned support");
  const createResolver = vi.fn();
  const report = await runUpgrade(
    root,
    distribution("2.0.0", {
      "SKILL.md": skill(),
      "init.md": "updated",
      "new.md": "new upstream",
    }),
    {},
    { createResolver },
  );
  expect(
    report.files.find((file) => file.path.endsWith("/new.md"))?.action,
  ).toBe("conflicted");
  expect(await read(root, ".agents/skills/idiom/new.md")).toBe(
    "user-owned support",
  );
  expect(await read(root, aux)).toBe("updated");
  expect(createResolver).not.toHaveBeenCalled();
});
test("baseline changed during resolution conflicts without overwriting it", async () => {
  const root = await temporary();
  await runUpgrade(root);
  await put(root, aux, "custom");
  const report = await runUpgrade(
    root,
    distribution("2.0.0", { "SKILL.md": skill(), "init.md": "new upstream" }),
    {},
    {
      createResolver: () => async (input) => {
        await put(
          root,
          pristinePath("idiom/init.md"),
          "external baseline change",
        );
        return {
          decision: "resolve",
          replacements: input.merge.conflicts.map((hunk) => ({
            id: hunk.id,
            text: hunk.local,
          })),
          reason: "local",
        };
      },
    },
  );
  expect(report.files[1]?.action).toBe("conflicted");
  expect(await read(root, aux)).toBe("custom");
  expect(await base(root, "idiom/init.md")).toBe("external baseline change");
});
test("manifest rename failure restores both live and pristine bytes", async () => {
  const root = await temporary();
  await runUpgrade(root);
  const before = await tree(root);
  const report = await runUpgrade(
    root,
    distribution("2.0.0", files(original.replace("zeta", "upstream"))),
    {},
    {
      apply: {
        beforeRename: async (path) => {
          if (path === manifestPath) throw new Error("manifest write failure");
        },
      },
    },
  );
  expect(report.files.every((file) => file.action === "conflicted")).toBe(true);
  expect(await tree(root)).toEqual(before);
});
test("unrelated scaffold, config and sibling skills are byte-preserved", async () => {
  const root = await temporary();
  await runUpgrade(root);
  for (const path of [
    "PRODUCT.md",
    "DESIGN.md",
    "autobuild.toml",
    ".idiom/project.json",
    ".agents/skills/sibling/SKILL.md",
  ])
    await put(root, path, `sentinel ${path}`);
  await runUpgrade(root, distribution("2.0.0", files("updated guidance\n")));
  for (const path of [
    "PRODUCT.md",
    "DESIGN.md",
    "autobuild.toml",
    ".idiom/project.json",
    ".agents/skills/sibling/SKILL.md",
  ])
    expect(await read(root, path)).toBe(`sentinel ${path}`);
});
test("retiring a whole unedited skill removes only its owned discovery link and empty directory", async () => {
  const root = await temporary();
  await runUpgrade(root);
  const report = await runUpgrade(root, distribution("2.0.0", {}));
  expect(report.files.every((file) => file.action === "removed")).toBe(true);
  const after = await tree(root);
  expect(after[".agents/skills/idiom"]).toBeUndefined();
  expect(after[".claude/skills/idiom"]).toBeUndefined();
  expect((await runUpgrade(root, distribution("2.0.0", {}))).files).toEqual([]);
});

test.each(["idiom", "ab-verify-idiom"] as const)(
  "%s retains customization through clean and resolved upgrades",
  async (name) => {
    const root = await temporary();
    const path = `.agents/skills/${name}/SKILL.md`;
    const first = distribution(
      "1.0.0",
      { "SKILL.md": skill(original, name), "support.md": "old support" },
      name,
    );
    if (name === "ab-verify-idiom")
      await put(root, path, skill(original, name));
    await runUpgrade(root, first);
    await put(root, path, skill(original.replace("alpha", "custom"), name));
    const second = distribution(
      "2.0.0",
      {
        "SKILL.md": skill(original.replace("zeta", "release"), name),
        "support.md": "new support",
      },
      name,
    );
    const merged = await runUpgrade(root, second);
    expect(merged.files.find((file) => file.path === path)?.action).toBe(
      "merged",
    );
    const third = distribution(
      "3.0.0",
      {
        "SKILL.md": skill(
          original.replace("alpha", "overlap").replace("zeta", "release"),
          name,
        ),
      },
      name,
    );
    const resolved = await runUpgrade(
      root,
      third,
      {},
      {
        createResolver: () => async (input) => ({
          decision: "resolve",
          replacements: input.merge.conflicts.map((hunk) => ({
            id: hunk.id,
            text: hunk.local,
          })),
          reason: "local",
        }),
      },
    );
    expect(resolved.files.find((file) => file.path === path)?.action).toBe(
      "resolved",
    );
    expect(await read(root, path)).toBe(
      skill(
        original.replace("alpha", "custom").replace("zeta", "release"),
        name,
      ),
    );
    expect(await base(root, `${name}/SKILL.md`)).toBe(
      third.skills[name]?.["SKILL.md"]?.content,
    );
    expect(
      resolved.files.find((file) => file.path.endsWith("support.md"))?.action,
    ).toBe("removed");
  },
);

test("tracked support filenames never inherit entries from the incoming object prototype", async () => {
  const root = await temporary();
  await runUpgrade(
    root,
    distribution("1.0.0", { "SKILL.md": skill(), constructor: "support" }),
  );
  const report = await runUpgrade(
    root,
    distribution("2.0.0", { "SKILL.md": skill() }),
  );
  expect(
    report.files.find((file) => file.path.endsWith("/constructor"))?.action,
  ).toBe("removed");
});
