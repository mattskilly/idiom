import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  buildLocalCli,
  engineFingerprint,
  packageLinks,
  // @ts-expect-error The local CLI builder is a dependency-free Node module.
} from "../scripts/idiom-local.mjs";

const root = join(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

describe("idiom-local", () => {
  test("links every packaged top-level entry except dist", () => {
    // A new package.json `files` entry must reach the out-of-tree package too.
    expect(packageLinks(manifest)).toEqual([
      ".agents",
      ".claude-plugin",
      "node_modules",
      "package.json",
      "plugin.json",
      "plugins",
      "server.json",
      "skills",
      "templates",
    ]);
  });

  test("builds this checkout's CLI without touching the tracked dist", async () => {
    const status = () =>
      execFileSync("git", ["status", "--porcelain", "--", "dist"], {
        cwd: root,
        encoding: "utf8",
      });
    const before = status();
    const { cli, cleanup, engine } = await buildLocalCli({ root });
    try {
      // The source fingerprint is baked in, so shared base records key on it.
      expect(engine).toMatch(/^source:[0-9a-f]{20}$/);
      expect(engine).toBe(await engineFingerprint({ root }));
      expect(readFileSync(join(dirname(cli), "main.js"), "utf8")).toContain(
        JSON.stringify(engine),
      );
      const version = execFileSync(process.execPath, [cli, "--version"], {
        cwd: root,
        encoding: "utf8",
      });
      expect(version).toContain(manifest.version);
      expect(status()).toBe(before);
    } finally {
      await cleanup();
    }
    expect(existsSync(dirname(dirname(dirname(cli))))).toBe(false);
  }, 60_000);
});
