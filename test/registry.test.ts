import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Ajv } from "ajv";
import formats from "ajv-formats";
import { expect, test } from "vitest";
import { mcpClient } from "./mcp-support.js";

const root = join(import.meta.dirname, "..");
const manifest = JSON.parse(await readFile(join(root, "server.json"), "utf8"));
const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const schemaBytes = await readFile(
  join(root, "test/fixtures/mcp-registry/server.schema.json"),
);
const ajv = new Ajv({ allErrors: true });
// The published OpenAPI-derived schema uses this annotation in draft-07.
ajv.addKeyword("example");
formats.default(ajv);
const validate = ajv.compile(JSON.parse(schemaBytes.toString()));

test("registry manifest validates against the unmodified published draft-07 schema", async () => {
  expect(validate(manifest), JSON.stringify(validate.errors)).toBe(true);
  expect(
    validate({
      ...manifest,
      name: "invalid",
      packages: [{ registryType: "invented" }],
    }),
  ).toBe(false);
  const provenance = await readFile(
    join(root, "test/fixtures/mcp-registry/README.md"),
    "utf8",
  );
  expect(provenance).toContain(
    createHash("sha256").update(schemaBytes).digest("hex"),
  );
  expect(manifest.$schema).toBe(
    "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  );
});

test("registry identity, version and stdio launcher agree with the npm package", () => {
  expect(manifest.name).toBe("io.github.mattskilly/idiom");
  expect(metadata.mcpName).toBe(manifest.name);
  expect(manifest.version).toBe(metadata.version);
  expect(manifest.title).toBe("Idiom");
  expect(manifest.websiteUrl).toBe("https://idiom.build");
  expect(manifest.repository).toEqual({
    url: "https://github.com/mattskilly/idiom",
    source: "github",
  });
  expect(manifest.packages).toEqual([
    {
      registryType: "npm",
      registryBaseUrl: "https://registry.npmjs.org",
      identifier: metadata.name,
      version: metadata.version,
      runtimeHint: "npx",
      transport: { type: "stdio" },
      packageArguments: [{ type: "positional", value: "mcp" }],
    },
  ]);
  expect(manifest.remotes).toBeUndefined();
});

test("publisher tool catalog lists exactly the live MCP tools within the registry size limit", async () => {
  const publisher =
    manifest._meta["io.modelcontextprotocol.registry/publisher-provided"];
  expect(Buffer.byteLength(JSON.stringify(publisher))).toBeLessThanOrEqual(
    4096,
  );
  const names = publisher.tools.map(
    (tool: { name: string; description: string }) => {
      expect(tool.description.trim().length).toBeGreaterThan(10);
      return tool.name;
    },
  );
  expect(new Set(names).size).toBe(names.length);
  const session = await mcpClient({ cwd: root });
  try {
    const { tools } = await session.client.listTools();
    expect(names.sort()).toEqual(tools.map((tool) => tool.name).sort());
  } finally {
    await session.close();
  }
});
