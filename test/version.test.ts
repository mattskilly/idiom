import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import {
  IDIOM_BUILD_COMMIT,
  IDIOM_VERSION,
  IDIOM_VERSION_DISPLAY,
} from "../src/version.js";

const packageMetadata = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

test("version is valid semver sourced from package metadata", () => {
  expect(IDIOM_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  expect(IDIOM_VERSION).toBe(packageMetadata.version);
});

test("direct source imports identify an unbundled development build", () => {
  expect(IDIOM_BUILD_COMMIT).toBe("unknown");
  expect(IDIOM_VERSION_DISPLAY).toBe(`${packageMetadata.version} (unknown)`);
  expect(IDIOM_VERSION).not.toContain("(");
});
