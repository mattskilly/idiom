import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { skillIdentity } from "../src/skills/merge.js";
import { templatesDirectory } from "../src/templates.js";
import { AUTOBUILD_SKILLS } from "../src/wiring/autobuild-skills.js";

const read = (path: string) =>
  readFile(join(templatesDirectory(), path), "utf8");

const shared = (source: string, name: string) => {
  const start = `<!-- idiom:shared ${name}:start -->`;
  const end = `<!-- idiom:shared ${name}:end -->`;
  expect(source.split(start)).toHaveLength(2);
  expect(source.split(end)).toHaveLength(2);
  return source.slice(source.indexOf(start), source.indexOf(end) + end.length);
};

test("the decision procedure is byte-identical in idiom-verify and idiom-fix", async () => {
  const verify = await read("idiom-verify/SKILL.md");
  const fix = await read("idiom-fix/SKILL.md");
  for (const name of ["decision-guidance", "decision-escalation"]) {
    const block = shared(verify, name);
    expect(block.length).toBeGreaterThan(200);
    expect(shared(fix, name)).toBe(block);
  }
  // idiom-verify's text is unchanged apart from the markers.
  expect(shared(verify, "decision-guidance")).toContain(
    "2. Before the normal gate, if the manifest's feedback is `guidance`",
  );
  expect(shared(verify, "decision-escalation")).toContain(
    "7. If guidance changed HEAD, the re-check is informative",
  );
});

test("idiom-fix names its step, the exact gate, the handoff, three rounds and forbids stash/reset/clean", async () => {
  const fix = await read("idiom-fix/SKILL.md");
  expect(skillIdentity(fix)).toBe("idiom-fix");
  expect(fix).toContain("disable-model-invocation: true");
  expect(fix).toContain('`skill = "idiom-fix"`');
  expect(fix).toContain("`idiom check --gate --fail-on major --deferred warn`");
  expect(fix).toContain("--json --handoff .ab/idiom-fix");
  expect(fix).toContain("At most **three** repair rounds");
  expect(fix).toContain("Never `git stash`, `git reset` or\n   `git clean`");
  expect(fix).toContain('ab verdict skip --reason "<gate.line>"');
  expect(fix).toContain("ab verdict fail --report .ab/idiom-fix/fixed.md");
  expect(fix).toContain("ab verdict fail --report .ab/idiom-fix/summary.md");
  expect(fix).toContain("ab artifact put idiom-fix-report");
  expect(fix).toContain("git format-patch --stdout startHead..HEAD");
  // Spelled so the public snapshot guard does not read the names themselves.
  expect(fix).not.toMatch(/say[\s_-]?when|builder[\s_-]?core|unb[o]unce/i);
});

test("the managed implement section keeps idiom-fix commits", () => {
  const implement = AUTOBUILD_SKILLS.find(
    (skill) => skill.surface === "autobuild-implement",
  );
  expect(implement?.body).toContain(
    "If an idiom-fix verify report says it committed fixes, keep those commits (apply its patch if they are missing) and finish; do not revert them.",
  );
});

test("the autobuild snippet documents the one-line fix-step swap", async () => {
  const snippet = await read("autobuild.idiom.toml");
  expect(snippet).toContain(
    '#   skill = "idiom-fix"  # fixes up to 3 new major findings per round, 3 rounds',
  );
  expect(snippet).toContain("sessionBudgetSeconds");
  // The live step is still the verifier; the swap is opt-in.
  expect(snippet).toMatch(/^skill = "idiom-verify"$/m);
});
