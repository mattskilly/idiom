#!/usr/bin/env node
// Loads before anything else so an old Node gets a clear message, not a module or syntax error.
import { nodeVersionProblem } from "./node-version.js";

const problem = nodeVersionProblem(process.versions.node);
if (problem !== undefined) {
  // stderr only: stdout belongs to the MCP protocol under `idiom mcp`.
  // exitCode, not process.exit: stderr to a pipe is asynchronous and could drop the message.
  process.stderr.write(`${problem}\n`);
  process.exitCode = 2;
} else {
  // A computed specifier keeps esbuild from bundling the program into the launcher.
  const main = (await import(new URL("./main.js", import.meta.url).href)) as {
    run: () => Promise<number>;
  };
  process.exitCode = await main.run();
}
