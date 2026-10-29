import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Sandbox } from "@vercel/sandbox";
import type { HostedConfig } from "./config.js";
import { LIMITS } from "./config.js";
import { HostedError } from "./errors.js";
import { validateOutput } from "./reports.js";
import {
  type HostedReport,
  type ReviewInput,
  reportSchema,
  type Stage,
} from "./schema.js";
import { firewall } from "./ssrf.js";

export interface WorkerSandbox {
  writeFiles(files: Array<{ path: string; content: Buffer }>): Promise<void>;
  runCommand(options: {
    cmd: string;
    args: string[];
    cwd: string;
  }): Promise<{ exitCode: number }>;
  read(path: string, maxBytes: number): Promise<Buffer>;
  stop(signal: AbortSignal): Promise<unknown>;
  delete(signal: AbortSignal): Promise<void>;
}
export type CreateSandbox = (
  options: Parameters<typeof Sandbox.create>[0],
) => Promise<WorkerSandbox>;
export const createSandbox: CreateSandbox = async (options) => {
  const sandbox = await Sandbox.create(options);
  return {
    writeFiles: (files) => sandbox.writeFiles(files),
    runCommand: (command) => sandbox.runCommand(command),
    async read(path, maxBytes) {
      // The worker is trusted code, but a compromised browser cannot turn
      // an artifact name into an arbitrary file or an oversized SDK transfer.
      if (
        !/^\/tmp\/idiom-output\/(?:report\.json|asset-\d{1,2}\.png)$/.test(path)
      )
        throw new HostedError("failed");
      for (const directory of ["/tmp", "/tmp/idiom-output", path]) {
        const stat = await sandbox.fs.lstat(directory);
        if (stat.isSymbolicLink()) throw new HostedError("failed");
        if (directory === path && (!stat.isFile() || stat.size > maxBytes))
          throw new HostedError("report-too-large");
      }
      const data = await sandbox.readFileToBuffer({ path });
      if (!data || data.length > maxBytes)
        throw new HostedError("report-too-large");
      return data;
    },
    stop: (signal) => sandbox.stop({ signal }),
    delete: (signal) => sandbox.delete({ signal }),
  };
};
export async function deadline<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        abort = () => reject(new HostedError("timeout"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}
export async function cleanupSandbox(sandbox: WorkerSandbox) {
  const signal = AbortSignal.timeout(5000);
  try {
    await deadline(sandbox.stop(signal), signal);
  } finally {
    await deadline(sandbox.delete(signal), signal);
  }
}
export async function runtimeIdentity() {
  const identity = JSON.parse(
    await readFile(join(process.cwd(), "hosted-dist/identity.json"), "utf8"),
  ) as { hash: string };
  return identity.hash;
}
export async function runSandbox(
  input: ReviewInput,
  config: HostedConfig,
  options: {
    id: string;
    deadlineAt: number;
    signal: AbortSignal;
    stage: (stage: Stage) => void;
    create?: CreateSandbox;
    identity?: () => Promise<string>;
    now?: () => number;
    lateCleanup?: (promise: Promise<unknown>) => void;
  },
) {
  const now = options.now ?? Date.now;
  if ((await (options.identity ?? runtimeIdentity)()) !== config.runtimeHash)
    throw new HostedError("unavailable");
  const remaining = options.deadlineAt - now();
  if (remaining <= 0) throw new HostedError("timeout");
  options.stage("starting");
  let acquired: WorkerSandbox | undefined;
  let abandoned = false;
  const creation = (options.create ?? createSandbox)({
    source: { type: "snapshot", snapshotId: config.snapshotId },
    persistent: false,
    timeout: Math.min(LIMITS.runMs, remaining),
    resources: { vcpus: 2 },
    env: {},
    networkPolicy: firewall(),
    tags: { feature: "idiom-hosted-review", run: options.id },
    signal: options.signal,
  }).then(async (sandbox) => {
    acquired = sandbox;
    if (abandoned) await cleanupSandbox(sandbox);
    return sandbox;
  });
  const late = creation.catch(() => undefined);
  options.lateCleanup?.(late);
  try {
    acquired = await deadline(creation, options.signal);
    await deadline(
      acquired.writeFiles([
        {
          path: "/tmp/idiom-input.json",
          content: Buffer.from(
            JSON.stringify({
              target: input.target,
              reference: input.reference,
              imageExtension: input.image?.extension,
              runtimeHash: config.runtimeHash,
              deadline: Math.min(
                options.deadlineAt - 10_000,
                now() + LIMITS.workerMs,
              ),
            }),
          ),
        },
        ...(input.image
          ? [{ path: "/tmp/idiom-image", content: input.image.bytes }]
          : []),
      ]),
      options.signal,
    );
    options.stage("reviewing");
    const command = await deadline(
      acquired.runCommand({
        cmd: "env",
        args: [
          "-i",
          "PATH=/usr/local/bin:/usr/bin:/bin",
          "PLAYWRIGHT_BROWSERS_PATH=/vercel/sandbox/idiom/browsers",
          "node",
          "/vercel/sandbox/idiom/runner.mjs",
        ],
        cwd: "/tmp",
      }),
      options.signal,
    );
    if (command.exitCode !== 0) throw new HostedError("failed");
    const json = await deadline(
      acquired.read("/tmp/idiom-output/report.json", LIMITS.reportBytes),
      options.signal,
    );
    let report: HostedReport;
    try {
      report = reportSchema.parse(JSON.parse(json.toString()));
    } catch {
      throw new HostedError("failed");
    }
    if (
      report.runtimeHash !== config.runtimeHash ||
      report.target !== input.target
    )
      throw new HostedError("failed");
    const assets = new Map<string, Buffer>();
    let size = json.length;
    for (const item of report.assets) {
      size += item.bytes;
      if (size > LIMITS.outputBytes) throw new HostedError("report-too-large");
      const data = await deadline(
        acquired.read(`/tmp/idiom-output/${item.name}`, item.bytes),
        options.signal,
      );
      assets.set(item.name, data);
    }
    validateOutput(report, assets);
    return { report, assets };
  } finally {
    abandoned = true;
    if (acquired) await cleanupSandbox(acquired);
  }
}

export async function cleanupAbandoned(now = Date.now()) {
  const sandboxes = await Sandbox.list({
    tags: { feature: "idiom-hosted-review" },
  });
  let deleted = 0;
  for await (const entry of sandboxes) {
    if (entry.persistent || entry.createdAt + LIMITS.runMs + 60_000 > now)
      continue;
    const sandbox = await Sandbox.get({ name: entry.name });
    const signal = AbortSignal.timeout(5000);
    try {
      await sandbox.stop({ signal });
    } catch {
      /* delete remains authoritative */
    }
    await sandbox.delete({ signal });
    deleted++;
  }
  return deleted;
}
