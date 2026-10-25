import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import {
  isCompatibleIdiomCommand,
  planAutobuildWiring,
} from "../src/autobuild/wiring.js";
import { autobuildTemplatePath } from "../src/templates.js";

const template = await readFile(autobuildTemplatePath(), "utf8");

function ready(source: string) {
  const plan = planAutobuildWiring(source, template);
  expect(plan.kind).toBe("ready");
  if (plan.kind !== "ready") throw new Error(plan.reason);
  return plan;
}

test.each([
  "idiom verify booking --spec .ab/spec.md --out .ab/idiom",
  "  idiom\tverify home-page --spec .ab/spec.md --out .ab/idiom  ",
  "idiom verify flow_1.2 --spec .ab/spec.md --out .ab/idiom",
])("recognizes compatible Idiom command %s", (command) => {
  expect(isCompatibleIdiomCommand(command)).toBe(true);
});

test.each([
  "",
  "idiom verify --spec .ab/spec.md --out .ab/idiom",
  "idiom verify booking --spec other.md --out .ab/idiom",
  "idiom verify booking --spec .ab/spec.md --out .ab/idiom --force",
  "idiom verify booking; rm x --spec .ab/spec.md --out .ab/idiom",
  "other verify booking --spec .ab/spec.md --out .ab/idiom",
  "idiom\u00a0verify booking --spec .ab/spec.md --out .ab/idiom",
])("rejects a foreign command %s", (command) => {
  expect(isCompatibleIdiomCommand(command)).toBe(false);
});

test.each([
  '[verify]\nsteps = ["typecheck"]\n',
  '[verify]\nsteps = [\n  "typecheck" # keep\n]\n',
  "[verify]\nsteps = []\n",
  "[verify]\n# keep comment\n",
  '[project]\nname = "example"\n',
  '[verify.test]\nkind = "command"\n',
])("patches a supported Autobuild shape without template prose", (source) => {
  const plan = ready(source);
  expect(plan.candidate).toContain('idiom-verify = "idiom verify booking');
  expect(plan.candidate).toContain("[verify.idiom]");
  expect(plan.candidate).not.toContain("Copy these entries");
  expect(plan.candidate).not.toContain("Also append");
  expect(plan.candidate).not.toContain("template intentionally");
  expect(plan.diff).toContain("+++ b/autobuild.toml");
  expect(ready(plan.candidate).complete).toBe(true);
});

test("places a missing verify parent before existing child tables", () => {
  const plan = ready('[verify.test]\nkind = "command"\n');
  expect(plan.candidate.indexOf("[verify]\n")).toBeLessThan(
    plan.candidate.indexOf("[verify.test]"),
  );
  expect(plan.candidate).toContain('steps = ["test", "idiom"]');
});

test("inserts the command inside an existing commands table without disturbing its boundary", () => {
  const source = `[commands]\ntest = "bun run test"\n\n[verify]\nsteps = ["test"]\n`;
  const plan = ready(source);
  expect(plan.candidate).toContain(
    `[commands]\ntest = "bun run test"\nidiom-verify = "idiom verify booking --spec .ab/spec.md --out .ab/idiom"\n\n[verify]\n`,
  );
});

test("preserves comments, custom paths, and compatible repository flow bytes", () => {
  const source = `# leading\n[commands]\nidiom-verify = "idiom   verify home-page --spec .ab/spec.md --out .ab/idiom" # custom\n\n[verify]\nsteps = ["test", "idiom"]\n\n[verify.idiom]\nkind = "agent"\nskill = "ab-verify-idiom"\npaths = ["custom/**"]\n`;
  const plan = ready(source);
  expect(plan.complete).toBe(true);
  expect(plan.candidate).toBe(source);
  expect(plan.diff).toBe("");
});

test("recognizes an unconditional pathless Idiom agent step as complete", () => {
  const source = `[commands]\nidiom-verify = "idiom verify home --spec .ab/spec.md --out .ab/idiom"\n[verify]\nsteps = ["idiom"]\n[verify.idiom]\nkind = "agent"\nskill = "ab-verify-idiom"\nalways = true\n`;
  const plan = ready(source);
  expect(plan.complete).toBe(true);
  expect(plan.candidate).toBe(source);
});

test.each([
  "not toml = [",
  '[commands]\nidiom-verify = "echo foreign"\n',
  '[verify]\nsteps = ["idiom", "idiom"]\n',
  '[verify]\nsteps = ["idiom"]\n[verify.idiom]\nkind = "command"\n',
  '[verify]\nsteps = ["idiom"]\n[verify.idiom]\nkind = "agent"\nskill = "ab-verify-idiom"\npaths = []\n',
])("fails closed with the complete manual template", (source) => {
  const plan = planAutobuildWiring(source, template);
  expect(plan.kind).toBe("manual");
  expect(plan.candidate).toBe(source);
  expect(plan.manualAddition).toBe(template);
});

test("preserves CRLF and missing final newline conventions", () => {
  const crlf = ready('[verify]\r\nsteps = ["test"]\r\n');
  expect(crlf.candidate.replaceAll("\r\n", "")).not.toContain("\n");
  expect(crlf.candidate.endsWith("\r\n")).toBe(true);

  const noFinal = ready('[verify]\nsteps = ["test"]');
  expect(noFinal.candidate.endsWith("\n")).toBe(false);
});

test("ignores header-like text in strings and comments", () => {
  const source = `title = "[verify]"\n# [commands]\n[verify]\nsteps = [\n  "test"\n]\n`;
  const plan = ready(source);
  expect(plan.candidate).toContain('title = "[verify]"');
  expect(plan.candidate).toContain("# [commands]");
});
