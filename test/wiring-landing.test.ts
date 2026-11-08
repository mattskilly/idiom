import { parse } from "smol-toml";
import { expect, test } from "vitest";
import { LANDING_REASON, landingWriter } from "../src/wiring/landing.js";
import { markers, sectionSpan } from "../src/wiring/sections.js";

const rule = { label: "design-review", mode: "consent" };

test("the owned rule goes before a broad leaf auto rule", () => {
  const original =
    '[project]\nname = "x" # keep\n\n[[landing]]\nfrom = "leaf"\nmode = "auto"\n';
  const result = landingWriter(original);
  expect(result.reason).toBe(LANDING_REASON);
  const parsed = parse(result.candidate);
  expect(parsed.landing).toEqual([rule, { from: "leaf", mode: "auto" }]);
  expect(parsed.project).toEqual({ name: "x" });
  expect(result.candidate).toContain('name = "x" # keep');
  expect(landingWriter(result.candidate).candidate).toBe(result.candidate);
  // Manual reversal: delete the marked block.
  const span = sectionSpan(result.candidate, markers("autobuild-landing"));
  expect(span).toBeDefined();
  if (span)
    expect(
      result.candidate.slice(0, span.start) +
        result.candidate.slice(span.end).replace(/^\n/, ""),
    ).toBe(original);
});

test("without landing rules the block is appended", () => {
  const candidate = landingWriter('[verify]\nsteps = ["test"]\n').candidate;
  expect(parse(candidate)).toEqual({
    verify: { steps: ["test"] },
    landing: [rule],
  });
});

test("a moved or edited owned block is restored before other rules", () => {
  const owned = landingWriter('[[landing]]\nmode = "auto"\n').candidate;
  const edited = owned.replace('mode = "consent"', 'mode = "auto"');
  expect(parse(landingWriter(edited).candidate).landing).toEqual([
    rule,
    { mode: "auto" },
  ]);
});

test("an effective unmarked equivalent is retained without adoption", () => {
  const original = '[[landing]]\nlabel = "design-review"\nmode = "consent"\n';
  const result = landingWriter(original);
  expect(result.candidate).toBe(original);
  expect(result.reason).toContain("Existing effective rule retained");
});

test("a shadowed equivalent still gets the owned rule first", () => {
  const original =
    '[[landing]]\nmode = "auto"\n\n[[landing]]\nlabel = "design-review"\nmode = "consent"\n';
  const parsed = parse(landingWriter(original).candidate);
  expect((parsed.landing as unknown[])[0]).toEqual(rule);
  expect(parsed.landing).toHaveLength(3);
});

test("inline landing arrays need a manual addition", () => {
  expect(() => landingWriter('landing = [{ mode = "auto" }]\n')).toThrow(
    /manual/,
  );
});
