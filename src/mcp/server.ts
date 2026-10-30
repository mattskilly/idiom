import { McpServer } from "@modelcontextprotocol/server";
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
  } = {},
) {
  const server = new McpServer(
    { name: "idiom", version: IDIOM_VERSION },
    { capabilities: { tools: {} } },
  );
  const queue = new ToolExecutionQueue();
  registerIdiomTools(
    server,
    projectBinding(server, options),
    queue,
    options.dependencies ?? {},
  );
  const close = server.close.bind(server);
  server.close = async () => {
    await queue.close();
    await close();
  };
  return server;
}
