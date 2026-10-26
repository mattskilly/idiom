import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import type { Page, Response } from "playwright";
import {
  MAX_REFERENCE_IMAGE_DIMENSION,
  referenceImageDimensions,
  referenceImageLimitIssue,
  sniffImageMediaType,
} from "../references/limits.js";
import {
  type DesignLocation,
  designLocationSchema,
  designSourceSchema,
  imageDesignExtension,
} from "../schemas/design.js";
import type {
  DesignDescriptor,
  DesignImage,
  DesignImageMediaType,
} from "./types.js";

export type DesignSource = {
  url: string;
  provenance: NonNullable<DesignDescriptor["resolved"]>;
  image?: DesignImage | undefined;
  close(): Promise<void>;
};
const extensionMedia: Record<string, DesignImageMediaType> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};
export function isFigmaHost(source: string): boolean {
  try {
    return /(^|\.)figma\.com$/i.test(new URL(source).hostname);
  } catch {
    return false;
  }
}
/** A page that shows one image at the viewport width; the browser scales it. */
export const designImageWrapper =
  '<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light"><title>Intended design image</title><style>html,body{margin:0;padding:0;background:#fff;color-scheme:light}img{display:block;width:100%;height:auto}</style></head><body><img src="/image" alt="Intended design"></body></html>';
const media: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".mp4": "video/mp4",
};
const contained = (root: string, file: string) => {
  const path = relative(root, file);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};
async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => unknown,
  signal: AbortSignal | undefined,
): Promise<{ port: number; close(): Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((yes, no) => {
    server.once("error", no);
    server.listen(0, "127.0.0.1", yes);
  });
  const close = async () => {
    signal?.removeEventListener("abort", abort);
    server.closeAllConnections();
    await new Promise<void>((yes) => server.close(() => yes()));
  };
  const abort = () => {
    server.closeAllConnections();
    server.close();
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) {
    await close();
    signal.throwIfAborted();
  }
  const address = server.address();
  if (!address || typeof address === "string") {
    await close();
    throw new Error("Design server failed to bind");
  }
  return { port: address.port, close };
}
async function resolveDesignImage(
  source: string,
  extension: string,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<DesignSource> {
  const entry = resolve(cwd, source);
  if (!(await stat(entry)).isFile())
    throw new Error(`Design image must be a file: ${entry}`);
  const bytes = await readFile(entry);
  const sniffed = sniffImageMediaType(bytes);
  if (sniffed === "image/gif" || sniffed === "image/svg+xml")
    throw new Error(
      `Design image ${entry} is ${sniffed === "image/gif" ? "a GIF" : "an SVG"}; export the design as PNG, JPEG or WebP.`,
    );
  const mediaType = extensionMedia[extension];
  if (!sniffed || sniffed !== mediaType)
    throw new Error(
      `Design image ${entry} does not contain ${mediaType ?? "image"} data${sniffed ? ` (it holds ${sniffed})` : ""}; export the design as PNG, JPEG or WebP with a matching extension.`,
    );
  const limit = referenceImageLimitIssue(bytes, sniffed);
  if (limit) throw new Error(`Design image ${entry} is too large: ${limit}`);
  const dimensions = referenceImageDimensions(bytes, sniffed);
  if (
    !dimensions ||
    dimensions.width < 1 ||
    dimensions.height < 1 ||
    dimensions.width > MAX_REFERENCE_IMAGE_DIMENSION ||
    dimensions.height > MAX_REFERENCE_IMAGE_DIMENSION
  )
    throw new Error(`Design image ${entry} has unreadable dimensions`);
  const server = await listen((request, response) => {
    const path = (request.url ?? "/").split(/[?#]/)[0];
    if (path === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(designImageWrapper);
    } else if (path === "/image") {
      response.writeHead(200, { "content-type": sniffed });
      response.end(bytes);
    } else {
      response.writeHead(404);
      response.end("Design resource not found");
    }
  }, signal);
  return {
    url: `http://127.0.0.1:${server.port}/`,
    provenance: {
      kind: "image",
      requested: source,
      final: entry,
      entry,
      mediaType: sniffed,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    image: {
      bytes,
      mediaType: sniffed,
      extension: extension === "jpeg" ? "jpg" : extension,
    },
    close: server.close,
  };
}
export async function resolveDesignSource(
  reference: DesignLocation,
  cwd: string,
  signal?: AbortSignal,
): Promise<DesignSource> {
  reference = designLocationSchema.parse(reference);
  signal?.throwIfAborted();
  if (typeof reference !== "string")
    return {
      url: reference.site,
      provenance: {
        kind: "site",
        requested: reference.site,
        final: reference.site,
      },
      close: async () => {},
    };
  const source = reference;
  if (isFigmaHost(source))
    throw new Error(
      "Figma frames are captured from the pinned frame cache, not loaded as an HTML design",
    );
  const extension = imageDesignExtension(source);
  if (extension !== undefined)
    return await resolveDesignImage(source, extension, cwd, signal);
  if (/^https?:/i.test(source))
    return {
      url: source,
      provenance: { kind: "url", requested: source, final: source },
      close: async () => {},
    };
  let entry = resolve(cwd, source);
  if ((await stat(entry)).isDirectory()) {
    const candidates = (await readdir(entry))
      .filter((name) => /\.html?$/i.test(name))
      .sort();
    const chosen = candidates.includes("index.html")
      ? "index.html"
      : candidates.length === 1
        ? candidates[0]
        : undefined;
    if (!chosen)
      throw new Error(
        `Design directory ${entry} needs index.html or one top-level HTML file; candidates: ${candidates.join(", ") || "none"}. Export a standalone HTML design.`,
      );
    entry = resolve(entry, chosen);
  }
  if (!/\.html?$/i.test(entry) || !(await stat(entry)).isFile())
    throw new Error(`Design entry must be an HTML file: ${entry}`);
  const root = await realpath(dirname(entry));
  if (!contained(root, await realpath(entry)))
    throw new Error("Design entry escapes its resource root");
  const server = await listen(async (request, response) => {
    try {
      // Decode before resolution and validate again after symlink resolution.
      const path = decodeURIComponent(
        (request.url ?? "/").split(/[?#]/)[0] ?? "/",
      );
      if (path.includes("\0") || path.includes("\\"))
        throw new Error("invalid path");
      let file = resolve(root, `.${path}`);
      if (!contained(root, file)) throw new Error("path escapes design root");
      if ((await stat(file)).isDirectory()) file = resolve(file, "index.html");
      file = await realpath(file);
      if (!contained(root, file))
        throw new Error("symlink escapes design root");
      const data = await readFile(file);
      response.writeHead(200, {
        "content-type":
          media[extname(file).toLowerCase()] ?? "application/octet-stream",
      });
      response.end(data);
    } catch {
      response.writeHead(404);
      response.end("Design resource not found");
    }
  }, signal);
  return {
    url: `http://127.0.0.1:${server.port}/${encodeURIComponent(basename(entry))}`,
    provenance: { kind: "file", requested: source, final: entry, entry },
    close: server.close,
  };
}
const remedy =
  "Use an accessible direct prototype or export standalone HTML and configure that file.";
const siteRemedy =
  "Reference a page that loads without signing in, or export it as standalone HTML or a PNG and configure that file.";
function validateResponse(response: Response | null, fix = remedy): void {
  if (!response?.ok())
    throw new Error(
      `Design navigation returned ${response?.status() ?? "no response"}. ${fix}`,
    );
  if (
    !/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(
      response.headers()["content-type"] ?? "",
    )
  )
    throw new Error(`Design response is not HTML. ${fix}`);
}
export function claudeWrapper(url: string): boolean {
  const parsed = new URL(url);
  return (
    /(^|\.)claude\.ai$/.test(parsed.hostname) &&
    /^\/(?:public\/)?(?:share|artifacts|design)(?:\/|$)/.test(parsed.pathname)
  );
}
/** Generic rendered preview discovery; no private provider endpoint or guessed selector. */
export async function navigateDesign(
  page: Page,
  source: DesignSource,
): Promise<number> {
  const kind = source.provenance.kind;
  const fix = kind === "site" ? siteRemedy : remedy;
  let response = await page.goto(source.url);
  validateResponse(response, fix);
  if (kind !== "image") designSourceSchema.parse(page.url());
  if (
    kind !== "site" &&
    kind !== "image" &&
    (claudeWrapper(source.url) || claudeWrapper(page.url()))
  ) {
    await page
      .waitForFunction(
        () =>
          [...document.querySelectorAll("iframe, a[rel=preview]")].some(
            (element) => {
              const rect = element.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0;
            },
          ),
        undefined,
        { timeout: 5000 },
      )
      .catch(() => undefined);
    const base = page.url();
    const previews = await page.evaluate(() => {
      const frames = [...document.querySelectorAll("iframe")]
        .filter((frame) => {
          const rect = frame.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        })
        .map((frame) => ({ src: frame.src, html: frame.srcdoc }));
      if (frames.length) return frames;
      return [
        ...document.querySelectorAll<HTMLAnchorElement>('a[rel="preview"]'),
      ].map((link) => ({ src: link.href, html: "" }));
    });
    if (previews.length !== 1)
      throw new Error(
        `Claude share has ${previews.length ? "ambiguous" : "no accessible"} HTML previews. ${remedy}`,
      );
    const preview = previews[0];
    if (!preview) throw new Error(remedy);
    if (preview.html) {
      const escaped = base
        .replaceAll("&", "&amp;")
        .replaceAll('"', "&quot;")
        .replaceAll("<", "&lt;");
      const html = preview.html.replace(
        /<head([^>]*)>/i,
        `<head$1><base href="${escaped}">`,
      );
      await page.goto("about:blank");
      await page.setContent(
        /<head[\s>]/i.test(preview.html)
          ? html
          : `<base href="${escaped}">${preview.html}`,
      );
      source.provenance = { ...source.provenance, kind: "inline", final: base };
    } else {
      const url = new URL(preview.src, base);
      designSourceSchema.parse(url.href);
      if (claudeWrapper(url.href))
        throw new Error(`Preview points to another share wrapper. ${remedy}`);
      response = await page.goto(url.href);
      validateResponse(response);
      source.provenance.final = page.url();
    }
  } else if (kind !== "file" && kind !== "image")
    source.provenance.final = page.url();
  const access = await page.evaluate(() => {
    const title = document.title.trim();
    const text = document.body?.innerText.trim() ?? "";
    const painted = [...document.querySelectorAll("body, body *")].some(
      (element) => {
        const rect = element.getBoundingClientRect(),
          style = getComputedStyle(element);
        if (
          rect.width <= 0 ||
          rect.height <= 0 ||
          style.display === "none" ||
          style.visibility === "hidden" ||
          Number(style.opacity) === 0
        )
          return false;
        const background = style.backgroundColor;
        return (
          !["transparent", "rgba(0, 0, 0, 0)"].includes(background) ||
          style.backgroundImage !== "none" ||
          style.boxShadow !== "none" ||
          ["Top", "Right", "Bottom", "Left"].some(
            (side) =>
              Number.parseFloat(
                style.getPropertyValue(`border-${side.toLowerCase()}-width`),
              ) > 0,
          )
        );
      },
    );
    return (
      (!text && !document.querySelector("img,svg,canvas,video") && !painted) ||
      /^(?:sign in|log in|access denied|unauthorized|forbidden|not found|link expired)(?:\b|$)/i.test(
        title,
      ) ||
      (text.length < 1500 &&
        /^(?:sign in to|log in to|access denied|this (?:link|design|artifact) (?:has expired|is (?:private|unavailable)))/i.test(
          text,
        ))
    );
  });
  if (access)
    throw new Error(
      `Design preview is empty, inaccessible, or an error page. ${fix}`,
    );
  return response?.status() ?? 200;
}
