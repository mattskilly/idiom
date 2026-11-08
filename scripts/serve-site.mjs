#!/usr/bin/env node
// Dependency-free static server for the built site (site/dist), used by this
// repository's own Idiom check. Mirrors vercel.json's cleanUrls and
// trailingSlash: false so captured pages resolve as they do on idiom.build.
//
//   PORT=4317 node scripts/serve-site.mjs
import { realpathSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".webp": "image/webp",
};

const isFile = async (path) => {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
};

// The file a URL path serves, or undefined; null when it escapes the root.
async function resolveFile(root, pathname) {
  const target = resolve(root, `.${pathname}`);
  if (target !== root && !target.startsWith(root + sep)) return null;
  if (pathname === "/") return join(root, "index.html");
  if (extname(pathname) !== "")
    return (await isFile(target)) ? target : undefined;
  for (const candidate of [`${target}.html`, join(target, "index.html")])
    if (await isFile(candidate)) return candidate;
  return undefined;
}

export function createSiteServer(rootDirectory) {
  const root = resolve(rootDirectory);
  return createServer(async (request, response) => {
    const send = (status, body, headers = {}) => {
      response.writeHead(status, headers);
      response.end(request.method === "HEAD" ? undefined : body);
    };
    if (request.method !== "GET" && request.method !== "HEAD")
      return send(405, "method not allowed\n", {
        "content-type": "text/plain; charset=utf-8",
        allow: "GET, HEAD",
      });
    const url = new URL(request.url ?? "/", "http://localhost");
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return send(400, "bad request\n", {
        "content-type": "text/plain; charset=utf-8",
      });
    }
    if (pathname.length > 1 && pathname.endsWith("/"))
      return send(308, "", {
        location: `${url.pathname.replace(/\/+$/, "") || "/"}${url.search}`,
      });
    const file = await resolveFile(root, pathname);
    if (file === null)
      return send(403, "forbidden\n", {
        "content-type": "text/plain; charset=utf-8",
      });
    if (file === undefined)
      return send(404, "not found\n", {
        "content-type": "text/plain; charset=utf-8",
      });
    const body = await readFile(file);
    send(200, body, {
      "content-type":
        contentTypes[extname(file).toLowerCase()] ?? "application/octet-stream",
      "content-length": body.length,
    });
  });
}

if (
  process.argv[1] &&
  realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)
) {
  const root = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "site",
    "dist",
  );
  const port = Number(process.env.PORT ?? 4317);
  createSiteServer(root).listen(port, "127.0.0.1", () => {
    console.error(`serving site/dist at http://127.0.0.1:${port}/`);
  });
}
