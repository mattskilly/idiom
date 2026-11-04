import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  commandStatus,
  jsonOutputs,
  mcpToolStatus,
} from "../src/interface/surfaces.js";
import { INTERFACE_VERSION } from "../src/interface/version.js";
import {
  buildInterfaceSnapshot,
  compareInterface,
  type InterfaceSnapshot,
  programCommands,
} from "./contract-support.js";

const snapshotFile = new URL("./contract/interface.json", import.meta.url);
const updating = process.env.IDIOM_UPDATE_CONTRACT === "1";

const BREAKING_MESSAGE =
  "Breaking change to a stable Idiom interface. See docs/stability.md: either keep the change additive, or bump INTERFACE_VERSION in src/interface/version.ts, list it under Interface in the CHANGELOG, and run `bun run contract:update`.";

describe("stable interface contract", () => {
  it("matches the recorded snapshot or moves the interface version", async () => {
    const current = await buildInterfaceSnapshot();
    const recorded = existsSync(snapshotFile)
      ? (JSON.parse(readFileSync(snapshotFile, "utf8")) as InterfaceSnapshot)
      : undefined;
    if (updating) {
      if (
        recorded !== undefined &&
        recorded.interfaceVersion === INTERFACE_VERSION
      ) {
        const issues = compareInterface(recorded, current);
        if (issues.length > 0)
          throw new Error(
            `Refusing to record a breaking change without an interface bump:\n${issues.join("\n")}\n${BREAKING_MESSAGE}`,
          );
      }
      writeFileSync(snapshotFile, `${JSON.stringify(current, null, 2)}\n`);
      return;
    }
    expect(
      recorded,
      "test/contract/interface.json is missing; run `bun run contract:update`",
    ).toBeDefined();
    if (recorded === undefined) return;
    expect(
      INTERFACE_VERSION,
      "INTERFACE_VERSION is lower than the recorded snapshot's; it may only move up. See docs/stability.md.",
    ).toBeGreaterThanOrEqual(recorded.interfaceVersion);
    // A moved version allows any change; the release check re-records it.
    if (INTERFACE_VERSION > recorded.interfaceVersion) return;
    expect(compareInterface(recorded, current), BREAKING_MESSAGE).toEqual([]);
  });

  it("advertises the interface version in the MCP initialize result", async () => {
    const current = await buildInterfaceSnapshot();
    expect(current.mcp.interfaceVersion).toBe(INTERFACE_VERSION);
  });

  it("classifies every command, and only real ones", () => {
    const paths = programCommands().map(({ path }) => path);
    expect(new Set(Object.keys(commandStatus))).toEqual(new Set(paths));
  });

  it("lists a --json payload for every command with --json, and only those", () => {
    const withJson = programCommands()
      .filter(({ command }) =>
        command.options.some((option) => option.long === "--json"),
      )
      .map(({ path }) => path);
    expect(new Set(jsonOutputs.map((output) => output.command))).toEqual(
      new Set(withJson),
    );
  });

  it("classifies every MCP tool, and only real ones", async () => {
    const current = await buildInterfaceSnapshot();
    expect(new Set(Object.keys(mcpToolStatus))).toEqual(
      new Set(current.mcp.tools.map((tool) => tool.name)),
    );
  });

  it("gives a contract to exactly the stable-additive payloads", () => {
    for (const output of jsonOutputs)
      expect(
        output.contract !== undefined,
        `${output.id}: a contract is present exactly when status is stable-additive`,
      ).toBe(output.status === "stable-additive");
  });

  it("reports nothing when a snapshot is compared with itself", async () => {
    const current = await buildInterfaceSnapshot();
    expect(
      compareInterface(current, structuredClone(current) as InterfaceSnapshot),
    ).toEqual([]);
  });

  it("reports removing findings from the check contract", async () => {
    const current = await buildInterfaceSnapshot();
    const mutated = structuredClone(current) as InterfaceSnapshot;
    const check = mutated.json.find((output) => output.id === "check");
    const properties = check?.schema?.properties as Record<string, unknown>;
    delete properties.findings;
    expect(compareInterface(current, mutated)).toEqual([
      '--json "check": property findings removed',
    ]);
  });
});
