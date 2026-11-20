import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { leaseServer, serverLeaseEligible } from "../src/gate/server-lease.js";
import { flowSchema } from "../src/schemas/flow.js";
import { projectSchema } from "../src/schemas/project.js";
import { fixtureCommand } from "./support/fixture-server.js";

const project = (server: Record<string, unknown> = {}) =>
  projectSchema.parse({
    version: 1,
    app: { name: "x", framework: "nextjs" },
    server: {
      build: "node -e 0",
      start: "node -e 0",
      readyUrl: "http://127.0.0.1:3199/ready",
      port: 3199,
      env: {},
      ...server,
    },
    capture: {},
    design: {},
    model: { provider: "anthropic", model: "unused" },
  });
const flow = (id: string, setup: unknown[] = []) =>
  flowSchema.parse({
    id,
    title: id,
    setup,
    intent: [],
    states: [
      { id: "s", description: "s", url: "/", expect: { textPresent: ["x"] } },
    ],
  });

test("one server for every gated flow only without setup steps or a data directory", () => {
  const plain = project();
  expect(
    serverLeaseEligible(plain, [flow("a"), flow("b")], {
      production: false,
      reused: false,
    }),
  ).toEqual({ eligible: true });
  expect(
    serverLeaseEligible(
      plain,
      [flow("a"), flow("b", [{ run: "node seed.mjs" }])],
      { production: false, reused: false },
    ),
  ).toEqual({ eligible: false, reason: "b has setup steps" });
  expect(
    serverLeaseEligible(
      project({ env: { DB: `$${"{dataDir}"}/db.sqlite` } }),
      [flow("a")],
      { production: false, reused: false },
    ),
  ).toEqual({ eligible: false, reason: "data directory in server config" });
  expect(
    serverLeaseEligible(plain, [flow("a")], {
      production: true,
      reused: false,
    }).eligible,
  ).toBe(false);
  expect(
    serverLeaseEligible(plain, [flow("a")], {
      production: false,
      reused: true,
    }).eligible,
  ).toBe(false);
});

test("a lease builds and starts the server once, on a free port, and stops it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "idiom-lease-"));
  try {
    await writeFile(
      join(directory, "server.mjs"),
      `import { createServer } from "node:http";
createServer((request, response) => response.end("ok")).listen(Number(process.env.PORT), "127.0.0.1");`,
    );
    let spawns = 0;
    const counted = ((...args: Parameters<typeof spawn>) => {
      spawns++;
      return spawn(...args);
    }) as typeof spawn;
    const lease = await leaseServer({
      projectDirectory: directory,
      project: project({
        start: fixtureCommand(join(directory, "server.mjs")),
        env: { PORT: "3199" },
      }),
      dependencies: { process: { spawn: counted, serverRegistry: false } },
    });
    try {
      // Build + start: one of each, however many flows reuse the lease.
      expect(spawns).toBe(2);
      const response = await fetch(lease.project.server.readyUrl);
      expect(await response.text()).toBe("ok");
      expect(lease.startMs).toBeGreaterThanOrEqual(0);
    } finally {
      await lease.stop();
    }
    await expect(
      fetch(lease.project.server.readyUrl, {
        signal: AbortSignal.timeout(2000),
      }),
    ).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
