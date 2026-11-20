import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { describe, expect, test } from "vitest";

const config = parse(
  readFileSync(join(import.meta.dirname, "..", "autobuild.toml"), "utf8"),
) as {
  commands: Record<string, string>;
  verify: { steps: string[] } & Record<string, unknown>;
  finalize: { steps: string[] } & Record<string, unknown>;
};

describe("autobuild.toml site gate", () => {
  test("gates every build with this repository's own Idiom", () => {
    expect(config.verify.steps).toContain("idiom-check");
    expect(config.verify["idiom-check"]).toMatchObject({
      kind: "check",
      command: "idiom-check",
      always: true,
    });
    expect(config.commands["idiom-check"]).toBe("node scripts/site-gate.mjs");
  });

  test("advances the shared site base record after every build", () => {
    expect(config.commands["idiom-advance"]).toBe(
      "node scripts/site-gate.mjs --advance",
    );
    expect(config.finalize.steps).toContain("idiom-advance");
    expect(config.finalize["idiom-advance"]).toEqual({
      kind: "check",
      command: "idiom-advance",
    });
  });
});
