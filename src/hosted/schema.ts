import { z } from "zod";
import {
  referenceImageDimensions,
  referenceImageLimitIssue,
  sniffImageMediaType,
} from "../references/limits.js";
import { LIMITS } from "./config.js";
import { HostedError } from "./errors.js";
import { publicUrl } from "./ssrf.js";

export type ReviewInput = {
  target: string;
  reference?: string;
  image?: { bytes: Buffer; extension: "png" | "jpg" | "webp" };
};
export const idPattern = /^[a-f0-9]{64}$/;
export const assetName = /^asset-\d{1,2}\.png$/;
const text = z.string().max(4096);
export const reportSchema = z
  .object({
    version: z.literal(1),
    target: text,
    runtimeHash: z.string().regex(idPattern),
    issues: z
      .array(
        z
          .object({
            title: text,
            severity: z.enum(["blocker", "major", "minor"]),
            detail: text,
            assets: z.array(z.string().regex(assetName)).max(8),
          })
          .strict(),
      )
      .max(5),
    filmstrips: z.array(z.string().regex(assetName)).max(LIMITS.assets),
    design: z
      .object({
        status: z.enum(["none", "compared", "unavailable"]),
        detail: text,
        assets: z.array(z.string().regex(assetName)).max(8),
      })
      .strict(),
    coverage: z.array(text).max(100),
    metrics: z
      .object({
        elapsedMs: z.number().nonnegative(),
        networkBytes: z.number().int().nonnegative().max(LIMITS.networkBytes),
        requests: z.number().int().nonnegative().max(LIMITS.requests),
        findings: z.number().int().nonnegative(),
      })
      .strict(),
    assets: z
      .array(
        z
          .object({
            name: z.string().regex(assetName),
            bytes: z.number().int().positive().max(LIMITS.assetBytes),
          })
          .strict(),
      )
      .max(LIMITS.assets),
  })
  .strict();
export type HostedReport = z.infer<typeof reportSchema>;
export type Stage =
  | "admitted"
  | "starting"
  | "reviewing"
  | "publishing"
  | "complete";
export type Progress = { type: "progress"; stage: Stage; message: string };
export function imageInput(bytes: Buffer): NonNullable<ReviewInput["image"]> {
  const media = sniffImageMediaType(bytes);
  if (
    bytes.length > LIMITS.imageBytes ||
    !media ||
    media === "image/svg+xml" ||
    media === "image/gif" ||
    referenceImageLimitIssue(bytes, media)
  )
    throw new HostedError("invalid-input", "image");
  const size = referenceImageDimensions(bytes, media);
  if (!size || size.width * size.height > 16_000_000)
    throw new HostedError("invalid-input", "image");
  return {
    bytes,
    extension:
      media === "image/jpeg" ? "jpg" : media === "image/webp" ? "webp" : "png",
  };
}
export async function boundedBody(
  request: Request,
  limit: number,
): Promise<Buffer> {
  if (Number(request.headers.get("content-length")) > limit)
    throw new HostedError("invalid-input");
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.length;
      if (bytes > limit) throw new HostedError("invalid-input");
      chunks.push(item.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks);
}
export async function parseInput(request: Request): Promise<ReviewInput> {
  try {
    if (
      !request.headers.get("content-type")?.startsWith("multipart/form-data;")
    )
      throw new HostedError("invalid-input");
    const bytes = await boundedBody(request, LIMITS.envelopeBytes);
    const data = await new Response(new Uint8Array(bytes), {
      headers: { "content-type": request.headers.get("content-type") ?? "" },
    }).formData();
    for (const key of data.keys())
      if (
        !["target", "reference", "image"].includes(key) ||
        data.getAll(key).length !== 1
      )
        throw new HostedError("invalid-input");
    const target = data.get("target");
    const reference = data.get("reference");
    const image = data.get("image");
    if (
      typeof target !== "string" ||
      (reference !== null && typeof reference !== "string")
    )
      throw new HostedError("invalid-input");
    const input: ReviewInput = { target: publicUrl(target.trim()).href };
    if (reference) {
      input.reference = publicUrl(reference.trim()).href;
      if (/(^|\.)figma\.com$/i.test(new URL(input.reference).hostname))
        throw new HostedError("invalid-input", "reference");
    }
    if (image !== null && (typeof image === "string" || image.size > 0)) {
      if (typeof image === "string" || input.reference)
        throw new HostedError("invalid-input", "image");
      input.image = imageInput(Buffer.from(await image.arrayBuffer()));
    }
    return input;
  } catch (error) {
    if (error instanceof HostedError) throw error;
    throw new HostedError("invalid-input");
  }
}
