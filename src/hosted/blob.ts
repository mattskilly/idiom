import { BlobPreconditionFailedError, del, get, list, put } from "@vercel/blob";
import { HostedError } from "./errors.js";

export class Conflict extends Error {}
export type Stored = { bytes: Buffer; etag: string };
export interface PrivateStore {
  get(path: string, maxBytes: number): Promise<Stored | null>;
  put(
    path: string,
    bytes: Buffer,
    options?: { etag?: string; contentType?: string },
  ): Promise<void>;
  del(paths: string[]): Promise<void>;
  list(
    prefix: string,
    cursor?: string,
  ): Promise<{ paths: string[]; cursor?: string }>;
}
/** Never expose Blob URLs; all reads bypass the CDN and are bounded. */
export const privateBlobStore: PrivateStore = {
  async get(path, maxBytes) {
    const result = await get(path, { access: "private", useCache: false });
    if (!result) return null;
    if (result.statusCode !== 200 || result.blob.size > maxBytes)
      throw new HostedError("unavailable");
    const reader = result.stream.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const value = await reader.read();
        if (value.done) break;
        size += value.value.length;
        if (size > maxBytes) throw new HostedError("unavailable");
        chunks.push(value.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return { bytes: Buffer.concat(chunks), etag: result.blob.etag };
  },
  async put(path, bytes, options) {
    try {
      await put(path, bytes, {
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: options?.etag !== undefined,
        ...(options?.etag ? { ifMatch: options.etag } : {}),
        contentType: options?.contentType ?? "application/json",
        cacheControlMaxAge: 0,
      });
    } catch (error) {
      if (error instanceof BlobPreconditionFailedError) throw new Conflict();
      // A racing create-if-absent can fail with an existing-object error.
      // A successful strong read distinguishes this from an unavailable store.
      if (
        !options?.etag &&
        (await this.get(path, bytes.length + 1024).catch(() => null))
      )
        throw new Conflict();
      throw new HostedError("unavailable");
    }
  },
  async del(paths) {
    if (paths.length) await del(paths);
  },
  async list(prefix, cursor) {
    const page = await list({
      prefix,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    return {
      paths: page.blobs.map((item) => item.pathname),
      ...(page.hasMore && page.cursor ? { cursor: page.cursor } : {}),
    };
  },
};
export async function allPaths(store: PrivateStore, prefix: string) {
  const paths: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.list(prefix, cursor);
    paths.push(...page.paths);
    cursor = page.cursor;
  } while (cursor);
  return paths;
}
