import { HostedError } from "./errors.js";

export const LIMITS = {
  runMs: 90_000,
  workerMs: 70_000,
  probeMs: 15_000,
  retentionMs: 7 * 86_400_000,
  envelopeBytes: 3 * 1024 * 1024,
  imageBytes: 2 * 1024 * 1024,
  assetBytes: 3 * 1024 * 1024,
  reportBytes: 512 * 1024,
  outputBytes: 12 * 1024 * 1024,
  assets: 24,
  networkBytes: 32 * 1024 * 1024,
  requests: 600,
  connections: 32,
  pages: 3,
  deliveries: 128,
  deliveryImageBytes: 128 * 3 * 1024 * 1024,
  deliveryLedgerBytes: 1024 * 1024 * 1024,
  deliveryAttempts: 4096,
  casAttempts: 8,
  ledgerBytes: 4 * 1024 * 1024,
  maxAdmissions: 10_000,
} as const;
export type HostedConfig = {
  cap: number;
  snapshotId: string;
  runtimeHash: string;
  ipSecret: string;
};
export function enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.IDIOM_HOSTED_REVIEW === "on";
}
export function microdollars(value: string | undefined): number {
  if (!value || !/^\d+(?:\.\d{1,6})?$/.test(value))
    throw new HostedError("unavailable");
  const [whole = "0", decimal = ""] = value.split(".");
  const amount = Number(whole) * 1_000_000 + Number(decimal.padEnd(6, "0"));
  if (!Number.isSafeInteger(amount) || amount <= 0)
    throw new HostedError("unavailable");
  return amount;
}
export function hostedConfig(
  env: NodeJS.ProcessEnv = process.env,
): HostedConfig {
  if (!enabled(env)) throw new HostedError("disabled");
  const cap = microdollars(env.IDIOM_HOSTED_MONTHLY_CAP_USD);
  const snapshotId = env.IDIOM_HOSTED_SNAPSHOT_ID;
  const runtimeHash = env.IDIOM_HOSTED_RUNTIME_HASH;
  const ipSecret = env.IDIOM_HOSTED_IP_SECRET;
  if (
    !snapshotId ||
    !/^snap_[\w-]+$/.test(snapshotId) ||
    !runtimeHash ||
    !/^[a-f0-9]{64}$/.test(runtimeHash) ||
    !ipSecret ||
    ipSecret.length < 32 ||
    !env.BLOB_READ_WRITE_TOKEN
  )
    throw new HostedError("unavailable");
  return { cap, snapshotId, runtimeHash, ipSecret };
}
