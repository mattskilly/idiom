import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import {
  initValidateJsonContract,
  runFailureJsonContract,
} from "../src/interface/surfaces.js";
import { INTERFACE_VERSION, jsonPayload } from "../src/interface/version.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function idiom(...args: string[]) {
  const cwd = await mkdtemp(join(tmpdir(), "idiom-json-"));
  directories.push(cwd);
  let stdout = "";
  let stderr = "";
  const code = await run(["node", "idiom", ...args], {
    cwd,
    stdout: (message) => {
      stdout += message;
    },
    stderr: (message) => {
      stderr += message;
    },
  });
  return { code, stdout, stderr };
}

/** Top-level `JSON.stringify(` calls in a source file, as balanced text. */
function stringifyCalls(source: string): string[] {
  const calls: string[] = [];
  let from = 0;
  for (;;) {
    const start = source.indexOf("JSON.stringify(", from);
    if (start < 0) return calls;
    const open = start + "JSON.stringify".length;
    let depth = 0;
    let quote: string | undefined;
    for (let index = open; index < source.length; index++) {
      const char = source[index];
      if (quote) {
        if (char === "\\") index++;
        else if (char === quote) quote = undefined;
        continue;
      }
      if (char === '"' || char === "'") quote = char;
      else if (char === "(" || char === "[" || char === "{") depth++;
      else if (char === ")" || char === "]" || char === "}") {
        depth--;
        if (depth === 0) {
          calls.push(source.slice(start, index + 1));
          from = index + 1;
          break;
        }
      }
    }
  }
}

describe("jsonPayload", () => {
  it("puts interfaceVersion first and keeps every key", () => {
    const parsed = JSON.parse(jsonPayload({ flow: "home", ok: true }));
    expect(Object.keys(parsed)).toEqual(["interfaceVersion", "flow", "ok"]);
    expect(parsed).toEqual({
      interfaceVersion: INTERFACE_VERSION,
      flow: "home",
      ok: true,
    });
  });
});

describe("--json emitters", () => {
  it.each(["src/cli.ts", "src/commands/brief.ts"])(
    "%s pretty-prints stdout JSON only through jsonPayload",
    async (file) => {
      const source = await readFile(
        new URL(`../${file}`, import.meta.url),
        "utf8",
      );
      const pretty = stringifyCalls(source).filter((call) =>
        /,\s*null,\s*2,?\s*\)$/.test(call),
      );
      // The one exception is brief list, a bare array (docs/stability.md).
      expect(pretty.filter((call) => !call.includes("entries.map"))).toEqual(
        [],
      );
      expect(pretty.length).toBe(file === "src/cli.ts" ? 1 : 0);
    },
  );

  it("init --validate --json carries interfaceVersion and meets its contract", async () => {
    const result = await idiom("init", "--validate", "--json");
    expect(result.code).toBe(2);
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({
      interfaceVersion: INTERFACE_VERSION,
      ready: false,
    });
    expect(initValidateJsonContract.safeParse(payload).success).toBe(true);
  });

  it("check --json prints the run-failure envelope with interfaceVersion", async () => {
    const result = await idiom("check", "home", "--json");
    expect(result.code).toBe(2);
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({
      interfaceVersion: INTERFACE_VERSION,
      flow: "home",
      failure: { stage: "preflight", cause: "no-project" },
    });
    expect(runFailureJsonContract.safeParse(payload).success).toBe(true);
  });
});
