import { McpServer } from "@modelcontextprotocol/server";
import { INTERFACE_VERSION } from "../interface/version.js";
import type { UpdateNoticeSession } from "../update/notice.js";
import { IDIOM_VERSION } from "../version.js";
import { projectBinding } from "./binding.js";
import { ToolExecutionQueue } from "./execution.js";
import { type McpDependencies, registerIdiomTools } from "./tools.js";

/** Cheap factory: project validation and capture occur only when a tool is called. */
export function createIdiomMcpServer(
  options: {
    project?: string | undefined;
    cwd?: string | undefined;
    dependencies?: McpDependencies | undefined;
    /** Once-per-session newer-version notice; see src/update/notice.ts. */
    update?: UpdateNoticeSession | undefined;
  } = {},
) {
  const instructions = options.update?.instructions();
  const server = new McpServer(
    { name: "idiom", version: IDIOM_VERSION },
    {
      capabilities: {
        tools: {},
        // Implementation-specific data lives under `experimental`; a key on
        // serverInfo would be stripped by the client. See docs/stability.md.
        experimental: { idiom: { interfaceVersion: INTERFACE_VERSION } },
      },
      ...(instructions === undefined ? {} : { instructions }),
    },
  );
  const queue = new ToolExecutionQueue();
  registerIdiomTools(server, projectBinding(server, options), queue, {
    ...options.dependencies,
    update: options.update,
  });
  const close = server.close.bind(server);
  server.close = async () => {
    await queue.close();
    await close();
  };
  return server;
}
