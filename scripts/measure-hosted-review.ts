import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { connect } from "node:net";
import { arch, cpus, platform, release } from "node:os";
import { chromium } from "playwright";
import { estimateCost } from "../src/hosted/cost.js";
import { runWorker } from "../src/hosted/runner.js";
import { imageInput, type ReviewInput } from "../src/hosted/schema.js";

const root = process.cwd();
const fixture = await readFile(`${root}/test/fixtures/hosted/page.html`);
const browser = await chromium.launch({ headless: true });
const sample = await browser.newPage({ viewport: { width: 600, height: 400 } });
await sample.setContent(fixture.toString());
const uploads = {
  png: await sample.screenshot({ type: "png" }),
  jpg: await sample.screenshot({ type: "jpeg" }),
  webp: Buffer.alloc(0),
};
// Chromium's canvas encoder provides a real WebP design export.
uploads.webp = Buffer.from(
  await sample.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 600;
    canvas.height = 400;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas unavailable");
    ctx.fillStyle = "#fafaf8";
    ctx.fillRect(0, 0, 600, 400);
    ctx.fillStyle = "#111";
    ctx.font = "32px sans-serif";
    ctx.fillText("Plan your next project", 24, 60);
    return canvas.toDataURL("image/webp").split(",")[1] as string;
  }),
  "base64",
);
const browserVersion = browser.version();
await browser.close();
const server = createServer((req, res) => {
  if (req.url === "/timeout") return;
  if (req.url?.startsWith("/sample.png")) {
    res.setHeader("content-type", "image/png");
    res.end(uploads.png);
    return;
  }
  res.setHeader("content-type", "text/html");
  res.end(fixture);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string")
  throw new Error("fixture did not bind");
const cases = [
  { name: "static-a", path: "/static" },
  { name: "static-b", path: "/static" },
  { name: "image-heavy-a", path: "/images" },
  { name: "image-heavy-b", path: "/images" },
  { name: "interactive-a", path: "/interactive" },
  { name: "interactive-b", path: "/interactive" },
  { name: "uploaded-png", path: "/static", image: uploads.png },
  { name: "uploaded-jpeg", path: "/static", image: uploads.jpg },
  { name: "uploaded-webp", path: "/static", image: uploads.webp },
  {
    name: "reference-site",
    path: "/static",
    reference: "http://fixture.example.com/reference",
  },
  { name: "timeout-boundary", path: "/timeout", timeout: 150 },
  { name: "large-output-boundary", path: "/large" },
];
const identity = JSON.parse(
  await readFile("hosted-dist/identity.json", "utf8"),
) as { hash: string };
const sourceFiles = execFileSync(
  "git",
  [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "src",
    "scripts/hosted",
    "test/fixtures/hosted",
  ],
  { encoding: "utf8" },
)
  .trim()
  .split("\n")
  .sort();
const sourceHash = createHash("sha256");
for (const path of sourceFiles) {
  sourceHash.update(path);
  sourceHash.update(await readFile(path));
}
const rows: Array<
  Record<string, unknown> & { name: string; status: string; elapsedMs: number }
> = [];
try {
  for (const item of cases) {
    const input: ReviewInput = {
      target: `http://fixture.example.com${item.path}`,
      ...(item.reference ? { reference: item.reference } : {}),
      ...(item.image ? { image: imageInput(item.image) } : {}),
    };
    const started = performance.now();
    const cpu = process.cpuUsage();
    let row: (typeof rows)[number];
    try {
      const result = await runWorker(input, {
        runtimeHash: identity.hash,
        signal: AbortSignal.timeout(item.timeout ?? 70_000),
        resolver: async () => [{ address: "8.8.8.8", family: 4 }],
        dial: () => connect({ host: "127.0.0.1", port: address.port }),
      });
      const outputBytes =
        Buffer.byteLength(JSON.stringify(result.report)) +
        [...result.assets.values()].reduce(
          (sum, bytes) => sum + bytes.length,
          0,
        );
      const elapsedMs = performance.now() - started;
      row = {
        name: item.name,
        fixture: item.path,
        status: "success",
        elapsedMs,
        inputBytes: fixture.length + (item.image?.length ?? 0),
        networkBytes: result.report.metrics.networkBytes,
        outputBytes,
        issues: result.report.issues.length,
        evidenceCount: result.assets.size,
        filmstrips: result.report.filmstrips.length,
        design: result.report.design.status,
        estimatedUsd: estimateCost(
          elapsedMs,
          result.report.metrics.networkBytes,
          outputBytes,
        ),
      };
    } catch (error) {
      row = {
        name: item.name,
        fixture: item.path,
        status: "failure",
        elapsedMs: performance.now() - started,
        inputBytes: fixture.length + (item.image?.length ?? 0),
        error: error instanceof Error ? error.message : String(error),
        outputBytes: 0,
      };
    }
    rows.push({ ...row, parentCpuMicros: process.cpuUsage(cpu) });
    console.log(`${row.name}: ${row.status} ${Math.round(row.elapsedMs)}ms`);
  }
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
const measured = rows.slice(0, 10).filter((row) => row.status === "success");
const sorted = measured.map((row) => row.elapsedMs).sort((a, b) => a - b);
const summary = {
  measuredRuns: measured.length,
  meanMs: sorted.reduce((a, b) => a + b, 0) / sorted.length,
  p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
  worstMs: sorted.at(-1),
};
await writeFile(
  "docs/hosted-review-runs.json",
  `${JSON.stringify({ version: 1, measuredAt: new Date().toISOString(), method: "Real runQuick deterministic engine + strict probe + hosted numeric-IP proxy against maintained local fixtures; injected resolver/dial only. Node CPU excludes Chromium child CPU. No paid Sandbox or Blob used. USD figures are estimates.", sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), sourceHash: sourceHash.digest("hex"), runtimeHash: identity.hash, machine: { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model, node: process.version, chromium: browserVersion }, summary, rows }, null, 2)}\n`,
);
if (measured.length < 10) process.exitCode = 1;
