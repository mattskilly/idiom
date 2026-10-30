import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/server";
import { IdiomError } from "../errors.js";
import { resolveProjectArgument } from "../project.js";

const PROJECT_FILE = join(".idiom", "project.json");
const ROOTS_TIMEOUT_MS = 5000;

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/**
 * Idiom's own installed plugin directory. Plugin hosts may start the server
 * there (Codex does), and it must never be treated as the user's project.
 */
export async function isIdiomPluginInstall(directory: string) {
  if (await exists(join(directory, PROJECT_FILE))) return false;
  try {
    const metadata = JSON.parse(
      await readFile(join(directory, "package.json"), "utf8"),
    ) as { name?: unknown };
    if (metadata.name !== "@mattskilly/idiom") return false;
  } catch {
    return false;
  }
  return (
    (await exists(join(directory, "plugin.json"))) ||
    (await exists(join(directory, ".claude-plugin", "plugin.json")))
  );
}

/** First file root holding an Idiom project, else the first file root. */
async function rootFromClient(server: McpServer) {
  const { roots } = await server.server.listRoots(undefined, {
    timeout: ROOTS_TIMEOUT_MS,
  });
  const directories = roots.flatMap((root) => {
    try {
      return root.uri.startsWith("file:") ? [fileURLToPath(root.uri)] : [];
    } catch {
      return [];
    }
  });
  for (const directory of directories)
    if (await exists(join(directory, PROJECT_FILE))) return directory;
  return directories[0];
}

/**
 * Resolves the bound project for each tool call. An explicit project wins;
 * otherwise the working directory, unless it is Idiom's plugin install, in
 * which case the client's MCP roots name the project.
 */
export function projectBinding(
  server: McpServer,
  options: { project?: string | undefined; cwd?: string | undefined },
): () => Promise<string> {
  if (options.project !== undefined) {
    const fixed = resolveProjectArgument(options.project, options.cwd);
    return async () => fixed;
  }
  const cwd = resolveProjectArgument(undefined, options.cwd);
  let plugin: Promise<boolean> | undefined;
  let fromRoots: Promise<string | undefined> | undefined;
  server.server.setNotificationHandler(
    "notifications/roots/list_changed",
    () => {
      fromRoots = undefined;
    },
  );
  return async () => {
    plugin ??= isIdiomPluginInstall(cwd);
    if (!(await plugin)) return cwd;
    if (server.server.getClientCapabilities()?.roots) {
      fromRoots ??= rootFromClient(server).catch(() => undefined);
      const root = await fromRoots;
      if (root !== undefined) return resolve(root);
    }
    throw new IdiomError(
      `Idiom MCP started in its own plugin directory (${cwd}) and the client did not name a project root. Open your project in the host so it starts the server there or advertises it as an MCP root, or run idiom mcp --project /absolute/project/path.`,
    );
  };
}
