import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  type CallToolResult,
  createMcpHandler,
} from "@modelcontextprotocol/server";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import formats from "ajv-formats";
import { INTERFACE_VERSION } from "../src/interface/version.js";
import { createIdiomMcpServer } from "../src/mcp/server.js";

type Tool = { name: string; outputSchema?: Record<string, unknown> };

/** Compiles each listed tool's advertised outputSchema, as a client would. */
export function outputValidators(tools: Tool[]) {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  formats.default(ajv);
  return new Map<string, ValidateFunction>(
    tools.flatMap((tool) =>
      tool.outputSchema === undefined
        ? []
        : [[tool.name, ajv.compile(tool.outputSchema)]],
    ),
  );
}

/**
 * Throws unless a successful result keeps its text content and carries
 * structuredContent that starts with interfaceVersion and validates against
 * the tool's advertised outputSchema. Error results are left alone.
 */
export function validateToolResult(
  validators: Map<string, ValidateFunction>,
  name: string,
  response: unknown,
) {
  const result = response as CallToolResult;
  if (result.isError) return;
  const fail = (problem: string) => {
    throw new Error(`MCP tool ${name}: ${problem}`);
  };
  if (!result.content.some((item) => item.type === "text"))
    fail("successful result has no text content");
  const data = result.structuredContent as Record<string, unknown> | undefined;
  if (data === undefined) fail("successful result has no structuredContent");
  const keys = Object.keys(data ?? {});
  if (keys[0] !== "interfaceVersion")
    fail(`structuredContent starts with ${keys[0]}, not interfaceVersion`);
  if (data?.interfaceVersion !== INTERFACE_VERSION)
    fail(`interfaceVersion is ${String(data?.interfaceVersion)}`);
  const validate = validators.get(name);
  if (validate === undefined) fail("no outputSchema advertised");
  if (validate?.(data) !== true)
    fail(
      `structuredContent does not match its outputSchema: ${JSON.stringify(validate?.errors)}`,
    );
}

export async function mcpClient(
  options: Parameters<typeof createIdiomMcpServer>[0],
) {
  const handler = createMcpHandler(() => createIdiomMcpServer(options));
  const client = new Client({ name: "idiom-test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://mcp.test/mcp"), {
      fetch: (input, init) => handler.fetch(new Request(input, init)),
    }),
  );
  const { tools } = await client.listTools();
  const validators = outputValidators(tools as Tool[]);
  // Every successful call in every MCP suite is checked against the
  // advertised outputSchema, the way a strict client would check it.
  const callTool = client.callTool.bind(client);
  client.callTool = (async (...args: Parameters<typeof callTool>) => {
    const response = await callTool(...args);
    validateToolResult(validators, args[0].name, response);
    return response;
  }) as typeof client.callTool;
  return {
    client,
    tools,
    validators,
    close: async () => {
      await client.close();
      await handler.close();
    },
  };
}
export function toolData<T>(response: unknown): T {
  const result = response as CallToolResult;
  if (result.isError) throw new Error(JSON.stringify(result.content));
  if (!result.structuredContent) throw new Error("Missing structured content");
  return result.structuredContent as T;
}
