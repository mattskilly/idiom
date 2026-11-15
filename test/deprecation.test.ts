import { beforeEach, describe, expect, it } from "vitest";
import {
  DEPRECATION_SILENCE_ENV,
  type Deprecation,
  deprecationMessage,
  resetDeprecationWarnings,
  warnDeprecated,
} from "../src/interface/deprecation.js";

const old: Deprecation = {
  surface: "idiom thing --old",
  replacement: "idiom thing --new",
  removedIn: "9.9.0",
};

beforeEach(() => {
  resetDeprecationWarnings();
});

describe("deprecation warnings", () => {
  it("names the surface, replacement, removal release and silencing variable", () => {
    expect(DEPRECATION_SILENCE_ENV).toBe("IDIOM_NO_DEPRECATION_WARNINGS");
    expect(deprecationMessage(old)).toBe(
      "Deprecated: idiom thing --old will be removed in 9.9.0; use idiom thing --new instead. Set IDIOM_NO_DEPRECATION_WARNINGS=1 to silence this warning.",
    );
  });

  it("writes at most once per process per surface", () => {
    const lines: string[] = [];
    const write = (line: string) => lines.push(line);
    expect(warnDeprecated(old, write, {})).toBe(true);
    expect(warnDeprecated(old, write, {})).toBe(false);
    expect(lines).toEqual([deprecationMessage(old)]);
    const other = { ...old, surface: "idiom other --old" };
    expect(warnDeprecated(other, write, {})).toBe(true);
    expect(lines).toHaveLength(2);
  });

  it("is silenced by the environment variable, except empty or 0", () => {
    const lines: string[] = [];
    const write = (line: string) => lines.push(line);
    expect(warnDeprecated(old, write, { [DEPRECATION_SILENCE_ENV]: "1" })).toBe(
      false,
    );
    expect(lines).toEqual([]);
    // A silenced call does not mark the surface as warned.
    expect(warnDeprecated(old, write, { [DEPRECATION_SILENCE_ENV]: "0" })).toBe(
      true,
    );
    resetDeprecationWarnings();
    expect(warnDeprecated(old, write, { [DEPRECATION_SILENCE_ENV]: "" })).toBe(
      true,
    );
    expect(lines).toHaveLength(2);
  });
});
