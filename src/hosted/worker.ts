import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LIMITS } from "./config.js";
import { HostedError } from "./errors.js";
import { runWorker } from "./runner.js";
import { imageInput, type ReviewInput } from "./schema.js";

async function main() {
  const base = "/vercel/sandbox/idiom";
  const identity = JSON.parse(
    await readFile(join(base, "identity.json"), "utf8"),
  ) as { hash: string };
  const actualHash = createHash("sha256")
    .update(await readFile(fileURLToPath(import.meta.url)))
    .digest("hex");
  if (identity.hash !== actualHash) throw new HostedError("unavailable");
  const raw = JSON.parse(await readFile("/tmp/idiom-input.json", "utf8")) as {
    target: string;
    reference?: string;
    imageExtension?: string;
    runtimeHash: string;
    deadline: number;
  };
  if (raw.runtimeHash !== identity.hash || !Number.isFinite(raw.deadline))
    throw new HostedError("unavailable");
  const signal = AbortSignal.timeout(
    Math.max(1, Math.min(LIMITS.workerMs, raw.deadline - Date.now())),
  );
  const input: ReviewInput = {
    target: raw.target,
    ...(raw.reference ? { reference: raw.reference } : {}),
  };
  if (raw.imageExtension)
    input.image = imageInput(await readFile("/tmp/idiom-image"));
  const { report, assets } = await runWorker(input, {
    runtimeHash: identity.hash,
    signal,
  });
  await mkdir("/tmp/idiom-output", { recursive: true });
  for (const [name, bytes] of assets)
    await writeFile(join("/tmp/idiom-output", name), bytes);
  await writeFile("/tmp/idiom-output/report.json", JSON.stringify(report));
}
main().catch(() => {
  process.stderr.write("Hosted worker failed.\n");
  process.exitCode = 1;
});
