import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { runQuick } from "../src/quick/run.js";

// The release first-run check (scripts/first-run.mjs) reviews this bundled
// page. It must keep producing findings as rules evolve, or the check would
// fail on "no finding appeared" for reasons unrelated to install time.

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test("the bundled first-run sample page produces a contrast finding through quick review", async () => {
  const page = await readFile(
    join(
      import.meta.dirname,
      "..",
      "scripts",
      "fixtures",
      "first-run",
      "index.html",
    ),
  );
  const server: Server = createServer((request, response) => {
    request.resume();
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(page);
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const { port } = server.address() as AddressInfo;

  const directory = await mkdtemp(join(tmpdir(), "idiom-first-run-sample-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));

  const result = await runQuick({
    urls: [`http://127.0.0.1:${port}/`],
    cwd: directory,
    out: join(directory, "run"),
  });
  expect(result.findingCount).toBeGreaterThanOrEqual(1);
  const findings = JSON.parse(
    await readFile(join(result.runDirectory, "findings.json"), "utf8"),
  ) as Array<{ rule?: string; category: string }>;
  expect(findings.some((finding) => finding.category === "contrast")).toBe(
    true,
  );
});
