import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { PNG } from "pngjs";
import { z } from "zod";
import { allPaths, Conflict, type PrivateStore } from "./blob.js";
import { LIMITS } from "./config.js";
import { HostedError } from "./errors.js";
import type { AdmissionLedger } from "./ledger.js";
import {
  assetName,
  type HostedReport,
  idPattern,
  reportSchema,
} from "./schema.js";

export const randomCapability = () => randomBytes(32).toString("hex");
const hash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export const prefixFor = (id: string) => `hosted/reports/${id}/`;
const manifestSchema = z
  .object({
    version: z.literal(1),
    id: z.string().regex(idPattern),
    createdAt: z.number(),
    expiresAt: z.number(),
    deleteHash: z.string().regex(idPattern),
    deleted: z.boolean(),
    assets: z.array(z.string().regex(assetName)).max(LIMITS.assets),
  })
  .strict();
type Manifest = z.infer<typeof manifestSchema>;
export function validatePng(bytes: Buffer) {
  if (
    bytes.length > LIMITS.assetBytes ||
    bytes.length < 24 ||
    bytes.toString("hex", 0, 8) !== "89504e470d0a1a0a" ||
    bytes.readUInt32BE(16) * bytes.readUInt32BE(20) > 16_000_000
  )
    throw new HostedError("report-too-large");
  try {
    PNG.sync.read(bytes, { checkCRC: true });
  } catch {
    throw new HostedError("failed");
  }
}
export function validateOutput(
  report: HostedReport,
  assets: Map<string, Buffer>,
) {
  reportSchema.parse(report);
  if (
    Buffer.byteLength(JSON.stringify(report)) > LIMITS.reportBytes ||
    new Set(report.assets.map((a) => a.name)).size !== report.assets.length ||
    report.assets.length !== assets.size
  )
    throw new HostedError("report-too-large");
  let total = Buffer.byteLength(JSON.stringify(report));
  for (const item of report.assets) {
    const bytes = assets.get(item.name);
    if (!bytes || bytes.length !== item.bytes) throw new HostedError("failed");
    validatePng(bytes);
    total += bytes.length;
  }
  if (total > LIMITS.outputBytes) throw new HostedError("report-too-large");
  const linked = [
    ...report.issues.flatMap((issue) => issue.assets),
    ...report.filmstrips,
    ...report.design.assets,
  ];
  if (linked.some((name) => !assets.has(name))) throw new HostedError("failed");
}
export class Reports {
  constructor(
    readonly store: PrivateStore,
    readonly ledger: Pick<AdmissionLedger, "delivery">,
    readonly now: () => number = Date.now,
  ) {}
  async publish(
    id: string,
    report: HostedReport,
    assets: Map<string, Buffer>,
    signal?: AbortSignal,
  ) {
    if (!idPattern.test(id)) throw new HostedError("failed");
    validateOutput(report, assets);
    const deleteToken = randomCapability();
    const createdAt = this.now();
    const manifest: Manifest = {
      version: 1,
      id,
      createdAt,
      expiresAt: createdAt + LIMITS.retentionMs,
      deleteHash: hash(deleteToken),
      deleted: false,
      assets: report.assets.map((a) => a.name),
    };
    const prefix = prefixFor(id);
    // Durable index first: interrupted/partial publications are sweepable.
    const index = `hosted/expiry/${id}.json`;
    await this.store.put(
      index,
      Buffer.from(
        JSON.stringify({ id, createdAt, expiresAt: manifest.expiresAt }),
      ),
    );
    try {
      for (const [name, bytes] of assets) {
        signal?.throwIfAborted();
        await this.store.put(prefix + name, bytes, {
          contentType: "image/png",
        });
      }
      signal?.throwIfAborted();
      await this.store.put(
        `${prefix}report.json`,
        Buffer.from(JSON.stringify(report)),
      );
      signal?.throwIfAborted();
      await this.store.put(
        `${prefix}manifest.json`,
        Buffer.from(JSON.stringify(manifest)),
      );
      signal?.throwIfAborted();
      return {
        id,
        url: `/r/${id}`,
        deleteToken,
        expiresAt: manifest.expiresAt,
      };
    } catch (error) {
      // If rollback fails, the durable index remains for cleanup.
      await this.purge(id).catch(() => undefined);
      throw error;
    }
  }
  async manifest(id: string, includeDeleted = false) {
    if (!idPattern.test(id)) throw new HostedError("gone");
    const stored = await this.store.get(`${prefixFor(id)}manifest.json`, 8192);
    if (!stored) throw new HostedError("gone");
    const manifest = manifestSchema.parse(JSON.parse(stored.bytes.toString()));
    if (
      manifest.id !== id ||
      this.now() >= manifest.expiresAt ||
      (!includeDeleted && manifest.deleted)
    )
      throw new HostedError("gone");
    return { ...stored, manifest };
  }
  async read(id: string) {
    await this.manifest(id);
    await this.ledger.delivery(id);
    const result = await this.store.get(
      `${prefixFor(id)}report.json`,
      LIMITS.reportBytes,
    );
    if (!result) throw new HostedError("gone");
    const report = reportSchema.parse(JSON.parse(result.bytes.toString()));
    const { manifest } = await this.manifest(id);
    return { report, expiresAt: manifest.expiresAt };
  }
  async asset(id: string, name: string) {
    if (!assetName.test(name)) throw new HostedError("gone");
    const { manifest } = await this.manifest(id);
    if (!manifest.assets.includes(name)) throw new HostedError("gone");
    await this.ledger.delivery(id);
    const result = await this.store.get(
      prefixFor(id) + name,
      LIMITS.assetBytes,
    );
    if (!result) throw new HostedError("gone");
    await this.manifest(id);
    return result.bytes;
  }
  async delete(id: string, token: string) {
    if (!idPattern.test(token)) throw new HostedError("gone");
    for (let attempt = 0; attempt < LIMITS.casAttempts; attempt++) {
      const { manifest, etag } = await this.manifest(id, true);
      if (
        !timingSafeEqual(
          Buffer.from(manifest.deleteHash, "hex"),
          Buffer.from(hash(token), "hex"),
        )
      )
        throw new HostedError("gone");
      if (!manifest.deleted) {
        try {
          await this.store.put(
            `${prefixFor(id)}manifest.json`,
            Buffer.from(JSON.stringify({ ...manifest, deleted: true })),
            { etag },
          );
        } catch (error) {
          if (error instanceof Conflict) continue;
          throw error;
        }
      }
      // Keep the small tombstone/hash until expiry for authenticated retries.
      const paths = (await allPaths(this.store, prefixFor(id))).filter(
        (path) => !path.endsWith("/manifest.json"),
      );
      await this.store.del(paths);
      return;
    }
    throw new HostedError("unavailable");
  }
  async purge(id: string) {
    await this.store.del(await allPaths(this.store, prefixFor(id)));
    await this.store.del([`hosted/expiry/${id}.json`]);
  }
}
