import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  type CallToolResult,
  createMcpHandler,
} from "@modelcontextprotocol/server";
import { createIdiomMcpServer } from "../src/mcp/server.js";

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
  return {
    client,
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
