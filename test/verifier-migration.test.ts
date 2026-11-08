import { mkdir, readFile, readlink, symlink } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "smol-toml";
import { expect, test } from "vitest";
import {
  setupAutobuild,
  setupOptionalVerifier,
} from "../src/autobuild/setup.js";
import { initProject } from "../src/commands/init.js";
import { upgradeCommand } from "../src/commands/upgrade.js";
import { readHistory } from "../src/skills/distribution.js";
import { renamedIdentity } from "../src/skills/migrate-verifier.js";
import {
  digest,
  loadPristine,
  manifestBytes,
  manifestPath,
  pristinePath,
} from "../src/skills/pristine.js";
import { upgradeSkills } from "../src/skills/upgrade.js";
import {
  readAutobuildVerifierSkillTemplate,
  templatesDirectory,
} from "../src/templates.js";
import {
  metadata,
  put,
  read,
  skill,
  temporary,
  tree,
} from "./skill-support.js";

const legacy = ".agents/skills/ab-verify-idiom";
const current = ".agents/skills/idiom-verify";
const config =
  '[commands]\nidiom-verify="idiom verify checkout --spec .ab/spec.md --out .ab/idiom"\n[verify]\nsteps=["custom"]\n[verify.custom]\nkind="agent"\nskill="ab-verify-idiom" # preserve comment\npaths=["client/**"]\nalways=true\n';
async function fixture(
  content = skill("local body\n", "ab-verify-idiom"),
  base?: string,
) {
  const root = await temporary();
  await put(root, "autobuild.toml", config);
  await put(root, `${legacy}/SKILL.md`, content);
  await put(root, `${legacy}/support.md`, "local support\n");
  await mkdir(join(root, ".claude/skills"), { recursive: true });
  await symlink(
    "../../.agents/skills/ab-verify-idiom",
    join(root, ".claude/skills/ab-verify-idiom"),
  );
  if (base) {
    await put(root, pristinePath("ab-verify-idiom/SKILL.md"), base);
    await put(
      root,
      manifestPath,
      manifestBytes({
        schema: 1,
        files: {
          "ab-verify-idiom/SKILL.md": { version: "old", digest: digest(base) },
        },
      }),
    );
  }
  return root;
}
const accept = {
  interactive: true,
  confirm: async () => true,
  write: () => {},
};

test("tracked customized migration preserves bytes/provenance, moves support and link; second run is a no-op", async () => {
  const base = skill("upstream body\n", "ab-verify-idiom");
  const local = `${base}our local addition\n`;
  const root = await fixture(local, base);
  const result = await setupAutobuild({ projectDirectory: root, ...accept });
  expect(result.kind).toBe("applied");
  expect(await read(root, `${current}/SKILL.md`)).toBe(renamedIdentity(local));
  expect(await read(root, `${current}/support.md`)).toBe("local support\n");
  expect(await read(root, pristinePath("idiom-verify/SKILL.md"))).toBe(base);
  expect((await metadata(root)).files["idiom-verify/SKILL.md"]).toEqual({
    version: "old",
    digest: digest(base),
  });
  expect(await readlink(join(root, ".claude/skills/idiom-verify"))).toBe(
    "../../.agents/skills/idiom-verify",
  );
  const actualConfig = await read(root, "autobuild.toml");
  expect(actualConfig).toContain('skill="idiom-verify" # preserve comment');
  expect(actualConfig).toContain('paths=["client/**"]\nalways=true');
  const before = await tree(root);
  expect(
    (await setupAutobuild({ projectDirectory: root, ...accept })).kind,
  ).toBe("already-wired");
  expect(await tree(root)).toEqual(before);
});
test.each(["decline", "dry-run", "noninteractive"])(
  "%s retains the entire migration tree",
  async (mode) => {
    const root = await fixture();
    const before = await tree(root);
    const result = await setupAutobuild({
      projectDirectory: root,
      ...accept,
      dryRun: mode === "dry-run",
      interactive: mode !== "noninteractive",
      confirm: async () => mode !== "decline",
    });
    expect(result.kind).toBe(
      mode === "decline" ? "declined" : "available-noninteractive",
    );
    expect(await tree(root)).toEqual(before);
    if ("migration" in result && mode !== "decline")
      expect(result.migration).toContain(
        "without inventing pristine provenance",
      );
  },
);
test("a preview-to-write config or support-file change prevents application", async () => {
  for (const path of [
    "autobuild.toml",
    `${legacy}/support.md`,
    `${legacy}/new.md`,
  ]) {
    const root = await fixture();
    const result = await setupAutobuild({
      projectDirectory: root,
      ...accept,
      confirm: async (request) => {
        if (request.kind === "apply-autobuild-config")
          await put(root, path, "changed\n");
        return true;
      },
    });
    expect(result.kind).toBe("manual");
    expect(await read(root, `${legacy}/SKILL.md`)).toContain("ab-verify-idiom");
    expect((await tree(root))[`${current}/SKILL.md`]).toBeUndefined();
  }
});
test("application failure restores the complete affected tree", async () => {
  const base = skill("base\n", "ab-verify-idiom");
  const root = await fixture(base, base);
  const before = await tree(root);
  const result = await setupAutobuild({
    projectDirectory: root,
    ...accept,
    apply: {
      beforeRename: async (path) => {
        if (path === manifestPath) throw new Error("injected failure");
      },
    },
  });
  expect(result.kind).toBe("manual");
  expect(await tree(root)).toEqual(before);
});
test.each(["both", "discovery", "manifest", "ancestor", "baseline"])(
  "%s conflict preserves both copies",
  async (mode) => {
    const root = await fixture();
    if (mode === "both") await put(root, `${current}/SKILL.md`, "foreign");
    if (mode === "discovery")
      await put(root, ".claude/skills/idiom-verify", "foreign");
    if (mode === "manifest") await put(root, manifestPath, "invalid");
    if (mode === "baseline")
      await put(root, pristinePath("idiom-verify/SKILL.md"), "foreign");
    if (mode === "ancestor") {
      const outside = await temporary();
      await put(outside, "sentinel", "safe");
      await symlink(outside, join(root, ".agents/skills/.idiom-pristine"));
    }
    const before = await tree(root);
    expect(
      (await setupAutobuild({ projectDirectory: root, ...accept })).kind,
    ).toBe("manual");
    expect(await tree(root)).toEqual(before);
  },
);
test("an exact untracked released skill recovers its real baseline before rename and upgrades normally", async () => {
  const release = (await readHistory()).releases.find(
    (item) => item.version === "0.1.0",
  );
  const hash = release?.files["ab-verify-idiom/SKILL.md"];
  const bytes = await readFile(
    join(templatesDirectory(), `skill-history/blobs/${hash}.md`),
    "utf8",
  );
  const root = await fixture(bytes);
  await setupAutobuild({ projectDirectory: root, ...accept });
  expect((await metadata(root)).files["idiom-verify/SKILL.md"]).toEqual({
    version: "0.1.0",
    digest: hash,
  });
  expect(await read(root, pristinePath("idiom-verify/SKILL.md"))).toBe(bytes);
  const report = await upgradeSkills({
    projectDirectory: root,
    skills: ["idiom-verify"],
    agent: false,
  });
  expect(report.files[0]?.action).toBe("adopted");
  expect(await read(root, `${current}/SKILL.md`)).toBe(
    await readAutobuildVerifierSkillTemplate(),
  );
});
test("unknown customized bytes move without invented provenance and remain unresolved", async () => {
  const root = await fixture();
  await setupAutobuild({ projectDirectory: root, ...accept });
  expect(
    (await loadPristine(root)).files["idiom-verify/SKILL.md"],
  ).toBeUndefined();
  const before = await tree(root);
  const report = await upgradeSkills({
    projectDirectory: root,
    skills: ["idiom-verify"],
    agent: false,
  });
  expect(report.files[0]?.action).toBe("conflicted");
  expect(await tree(root)).toEqual(before);
});
test("upgrade shares gate and migration confirmation, while decline excludes legacy content from normal upgrades", async () => {
  const root = await fixture();
  const report = await upgradeCommand({
    project: root,
    ...accept,
    confirm: async () => false,
    agent: false,
  });
  expect(report.autobuild?.kind).toBe("declined");
  expect(await read(root, "autobuild.toml")).toBe(config);
  expect(await read(root, `${legacy}/SKILL.md`)).toContain("ab-verify-idiom");
  expect(report.files.some((file) => file.skill === "idiom-verify")).toBe(
    false,
  );
});

test("optional verifier selects an actual flow and configured globs only after explicit ticket consent", async () => {
  const root = await temporary();
  await initProject({ project: root, yes: true });
  await put(root, "autobuild.toml", "[verify]\nsteps=[]\n");
  const project = JSON.parse(await read(root, ".idiom/project.json"));
  project.agent = { uiGlobs: ["client/**", "theme/**"] };
  await put(root, ".idiom/project.json", JSON.stringify(project));
  for (const id of ["checkout", "account"])
    await put(
      root,
      `.idiom/flows/${id}.json`,
      JSON.stringify({
        id,
        title: id,
        intent: [],
        setup: [],
        states: [{ id: "home", description: "Home", url: "/", expect: {} }],
      }),
    );
  const offers: string[] = [];
  const messages: string[] = [];
  await setupOptionalVerifier({
    projectDirectory: root,
    ...accept,
    write: (value) => {
      messages.push(value);
    },
    confirm: async (request) => {
      offers.push(request.prompt);
      return (
        request.kind !== "select-verifier-flow" ||
        request.prompt.includes("checkout")
      );
    },
  });
  expect(
    offers.findIndex((value) => value.includes("account")),
    messages.join("\n"),
  ).toBeLessThan(offers.findIndex((value) => value.includes("checkout")));
  const wired = await read(root, "autobuild.toml");
  expect(wired).toContain("idiom verify checkout --spec");
  expect(parse(wired).verify).toMatchObject({
    idiom: {
      paths: ["client/**", "theme/**", ".idiom/**", "PRODUCT.md", "DESIGN.md"],
    },
  });
  expect(await read(root, `${current}/SKILL.md`)).toBe(
    await readAutobuildVerifierSkillTemplate(),
  );
  expect((await metadata(root)).files["idiom-verify/SKILL.md"]).toBeDefined();
  const before = await tree(root);
  await setupOptionalVerifier({
    projectDirectory: root,
    ...accept,
    confirm: async () => {
      throw new Error("unexpected prompt");
    },
  });
  expect(await tree(root)).toEqual(before);
});

test("a tracked legacy customization merges with the generic verifier after migration", async () => {
  const incoming = await readAutobuildVerifierSkillTemplate();
  const base = incoming
    .replace("name: idiom-verify", "name: ab-verify-idiom")
    .replace("# Idiom verifier", "# Previous verifier");
  const root = await fixture(`${base}Repository-specific guidance\n`, base);
  const report = await upgradeCommand({
    project: root,
    agent: false,
    ...accept,
  });
  expect(report.autobuild?.kind).toBe("applied");
  expect(
    report.files.find((file) => file.skill === "idiom-verify")?.action,
  ).toBe("merged");
  expect(await read(root, `${current}/SKILL.md`)).toBe(
    `${incoming}Repository-specific guidance\n`,
  );
});
test("a both-name migration conflict excludes the current verifier from automatic content upgrades", async () => {
  const root = await fixture();
  const incoming = await readAutobuildVerifierSkillTemplate();
  const prior = incoming.replace("# Idiom verifier", "# Prior release heading");
  await put(root, `${current}/SKILL.md`, prior);
  await put(root, pristinePath("idiom-verify/SKILL.md"), prior);
  await put(
    root,
    manifestPath,
    manifestBytes({
      schema: 1,
      files: {
        "idiom-verify/SKILL.md": { version: "prior", digest: digest(prior) },
      },
    }),
  );
  const report = await upgradeCommand({
    project: root,
    agent: false,
    ...accept,
  });
  expect(report.autobuild?.kind).toBe("manual");
  expect(await read(root, `${current}/SKILL.md`)).toBe(prior);
  expect(await read(root, `${legacy}/SKILL.md`)).toContain(
    "name: ab-verify-idiom",
  );
  expect(report.files.some((file) => file.skill === "idiom-verify")).toBe(
    false,
  );
});
test("the agent gate requires an accessible skill tree and protects foreign ancestry", async () => {
  const root = await temporary();
  const outside = await temporary();
  await put(outside, "sentinel", "untouched");
  await symlink(outside, join(root, ".agents"));
  await put(root, "autobuild.toml", "[verify]\nsteps=[]\n");
  const result = await initProject({
    project: root,
    ...accept,
    confirm: async (request) => request.kind === "apply-wiring",
  });
  expect(result.autobuild.kind).toBe("manual");
  expect(await read(root, "autobuild.toml")).not.toContain("idiom-check");
  expect(await read(outside, "sentinel")).toBe("untouched");
});

test("optional setup sees a newly generated flow and discloses conservative applicability", async () => {
  const root = await temporary();
  await put(root, "autobuild.toml", "[verify]\nsteps=[]\n");
  const { constructSiteFlow } = await import("../src/flows/generate.js");
  const messages: string[] = [];
  const result = await initProject({
    project: root,
    write: (value) => {
      messages.push(value);
    },
    confirm: async (request) =>
      [
        "apply-wiring",
        "offer-flow-generation",
        "select-verifier-flow",
      ].includes(request.kind),
    // The verifier is default off; it is chosen in the selection step.
    wiringDependencies: {
      select: async ({ defaults }) => ({
        ...defaults,
        selected: [...defaults.selected, "autobuild-verifier"],
      }),
    },
    generateFlows: async ({ project }) =>
      constructSiteFlow(project, {
        routes: [{ route: "/", path: "/", sources: [] }],
        warnings: [],
      }),
  });
  expect(result.flows.kind).toBe("generated");
  expect(await read(root, "autobuild.toml")).toContain(
    "idiom verify site --spec",
  );
  expect(parse(await read(root, "autobuild.toml")).verify).toMatchObject({
    idiom: { paths: ["**"] },
  });
  expect(messages.join("\n")).toContain(
    "narrower applicability could not be established",
  );
});

test("agent gate installs its shared skill, discovery and pristine once, within rollback", async () => {
  const root = await temporary();
  await put(root, "autobuild.toml", "[verify]\nsteps=[]\n");
  expect(
    (await setupAutobuild({ projectDirectory: root, ...accept })).kind,
  ).toBe("applied");
  expect(await read(root, `${current}/SKILL.md`)).toBe(
    await readAutobuildVerifierSkillTemplate(),
  );
  expect(await readlink(join(root, ".claude/skills/idiom-verify"))).toBe(
    "../../.agents/skills/idiom-verify",
  );
  expect(
    (await loadPristine(root)).files["idiom-verify/SKILL.md"]?.digest,
  ).toBe(digest(await readAutobuildVerifierSkillTemplate()));
  const before = await tree(root);
  expect(
    (await setupAutobuild({ projectDirectory: root, ...accept })).kind,
  ).toBe("already-wired");
  expect(await tree(root)).toEqual(before);
  const failing = await temporary();
  await put(failing, "autobuild.toml", "[verify]\nsteps=[]\n");
  const original = await tree(failing);
  expect(
    (
      await setupAutobuild({
        projectDirectory: failing,
        ...accept,
        apply: {
          beforeRename: async (path) => {
            if (path === "autobuild.toml") throw new Error("injected");
          },
        },
      })
    ).kind,
  ).toBe("manual");
  expect(await tree(failing)).toEqual(original);
});

test.each(["--yes", "dry-run"])(
  "%s offers agent installation without writing",
  async (mode) => {
    const root = await temporary();
    await put(root, "autobuild.toml", "[verify]\nsteps=[]\n");
    const before = await tree(root);
    expect(
      (
        await setupAutobuild({
          projectDirectory: root,
          interactive: mode === "dry-run",
          dryRun: mode === "dry-run",
        })
      ).kind,
    ).toBe("available-noninteractive");
    expect(await tree(root)).toEqual(before);
  },
);
