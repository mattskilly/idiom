import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  fixtureCommand,
  fixtureEvalCommand,
} from "./support/fixture-server.js";

export const SERVER = resolve("test/fixtures/capture/server.mjs");

export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("no port");
  await new Promise<void>((accept) => server.close(() => accept()));
  return address.port;
}

/** A project whose one flow, `home`, is served by the given start command. */
export async function doctorProject(
  server: { start: string; startupTimeoutMs?: number },
  port: number,
  directories: string[],
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "idiom-doctor-test-"));
  directories.push(directory);
  await mkdir(join(directory, ".idiom", "flows"), { recursive: true });
  await writeFile(
    join(directory, ".idiom", "project.json"),
    JSON.stringify({
      version: 1,
      app: { name: "doctor", framework: "other" },
      server: {
        build: "node -e 0",
        readyUrl: `http://127.0.0.1:${port}/`,
        port,
        env: {},
        ...server,
      },
      viewports: [{ name: "desktop", width: 800, height: 600 }],
      capture: {},
      design: {},
      model: { provider: "anthropic", model: "unused" },
    }),
  );
  await writeFile(
    join(directory, ".idiom", "flows", "home.json"),
    JSON.stringify({
      id: "home",
      title: "Home",
      intent: [],
      setup: [],
      states: [{ id: "home", description: "Home", url: "/", expect: {} }],
    }),
  );
  return directory;
}

/** A project whose fixture server passes every doctor step. */
export async function passingProject(directories: string[]) {
  const port = await freePort();
  return {
    port,
    directory: await doctorProject(
      { start: fixtureCommand(SERVER) },
      port,
      directories,
    ),
  };
}

/** A project whose server starts but never becomes ready. */
export async function neverReadyProject(directories: string[]) {
  const port = await freePort();
  return {
    port,
    directory: await doctorProject(
      {
        start: fixtureEvalCommand("setInterval(() => {}, 1000)"),
        startupTimeoutMs: 1_500,
      },
      port,
      directories,
    ),
  };
}
