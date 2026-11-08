import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
// @ts-expect-error The site server is a dependency-free Node module.
import { createSiteServer } from "../scripts/serve-site.mjs";

describe("serve-site", () => {
  let directory: string;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "serve-site-"));
    const site = join(directory, "dist");
    await mkdir(join(site, "docs"), { recursive: true });
    await writeFile(join(site, "index.html"), "<main>home</main>");
    await writeFile(join(site, "docs.html"), "<main>docs</main>");
    await writeFile(join(site, "docs", "rules.html"), "<main>rules</main>");
    await writeFile(join(site, "docs", "site.css"), "body{}");
    await writeFile(join(site, "llms.txt"), "llms");
    await writeFile(join(directory, "secret.txt"), "secret");
    server = createSiteServer(site);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((done) => server.close(done));
    await rm(directory, { recursive: true, force: true });
  });

  const get = (path: string, init?: RequestInit) =>
    fetch(`${base}${path}`, { redirect: "manual", ...init });

  test("serves clean URLs like vercel.json's cleanUrls", async () => {
    expect(await (await get("/")).text()).toBe("<main>home</main>");
    expect(await (await get("/docs")).text()).toBe("<main>docs</main>");
    expect(await (await get("/docs/rules")).text()).toBe("<main>rules</main>");
    expect((await get("/")).headers.get("content-type")).toMatch(/^text\/html/);
  });

  test("redirects a trailing slash to the slashless path", async () => {
    const response = await get("/docs/");
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("/docs");
  });

  test("serves literal files with their content types", async () => {
    const css = await get("/docs/site.css");
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toMatch(/^text\/css/);
    const txt = await get("/llms.txt");
    expect(txt.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(await txt.text()).toBe("llms");
  });

  test("answers 404 for missing paths and the hosted API", async () => {
    expect((await get("/nope")).status).toBe(404);
    expect((await get("/api/x")).status).toBe(404);
  });

  test("never serves files outside the root", async () => {
    for (const path of [
      "/%2e%2e/secret.txt",
      "/docs%2f..%2f..%2fsecret.txt",
      "/..%2fsecret.txt",
    ]) {
      const response = await get(path);
      expect(response.status, path).not.toBe(200);
      expect(await response.text(), path).not.toContain("secret");
    }
    expect((await get("/docs%2f..%2f..%2fsecret.txt")).status).toBe(403);
  });

  test("HEAD has no body and other methods are refused", async () => {
    const head = await get("/", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect((await get("/", { method: "POST" })).status).toBe(405);
  });
});
