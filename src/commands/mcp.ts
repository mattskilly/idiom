import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createIdiomMcpServer } from "../mcp/server.js";
import { createUpdateNoticeSession } from "../update/notice.js";

/** Own the session; stdout belongs exclusively to the official SDK transport. */
export async function mcpCommand(
  options: { project?: string | undefined; cwd?: string | undefined } = {},
): Promise<void> {
  // Cache-only before initialize; a stale cache refreshes in the background.
  const update = await createUpdateNoticeSession({
    project: options.project,
    cwd: options.cwd,
  });
  let server: ReturnType<typeof createIdiomMcpServer> | undefined;
  const handle = serveStdio(
    () => {
      server = createIdiomMcpServer({
        project: options.project,
        cwd: options.cwd,
        update,
      });
      return server;
    },
    {
      onerror: (error) => process.stderr.write(`Idiom MCP: ${error.message}\n`),
    },
  );
  await new Promise<void>((resolve) => {
    let closing = false;
    const shutdown = () => {
      if (closing) return;
      closing = true;
      process.stdin.off("end", shutdown);
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      // Closing the queue aborts active and queued tools before transport teardown.
      void (async () => {
        try {
          await server?.close();
          // Bounded by the update deadline; leaves no cache write running.
          await update.settled();
          await handle.close();
        } catch (error) {
          process.stderr.write(`Idiom MCP shutdown: ${String(error)}\n`);
        } finally {
          resolve();
        }
      })();
    };
    process.stdin.once("end", shutdown);
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}
