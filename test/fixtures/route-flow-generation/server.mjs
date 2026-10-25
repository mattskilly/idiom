import { existsSync } from "node:fs";
import { createServer } from "node:http";

const port = Number(process.env.PORT || 3000);
const document = (path, extra = "") =>
  `<!doctype html><html lang="en"><head><title>Route fixture</title></head><body><main><h1>Page ${path}</h1>${extra}</main></body></html>`;
const server = createServer((req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  const origin = `http://127.0.0.1:${port}`;
  const xml = (body) => {
    res.setHeader("content-type", "application/xml");
    res.end(body);
  };
  if (path === "/slow") return setTimeout(() => res.end(document(path)), 500);
  if (path === "/set-cookie")
    res.setHeader("set-cookie", "session=authenticated; Path=/");
  if (path === "/cookie-check" && req.headers.cookie)
    return res.end(document(path, '<input type="password">'));
  if (path === "/sitemap.xml")
    return xml(
      `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${origin}/child.xml</loc></sitemap><sitemap><loc>${origin}/sitemap.xml</loc></sitemap><sitemap><loc>https://example.com/foreign.xml</loc></sitemap></sitemapindex>`,
    );
  if (path === "/child.xml")
    return xml(
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="urn:image"><url><loc>${origin}/sitemap-only?a=1&amp;b=2</loc><image:loc>${origin}/extension-only</image:loc></url><url><loc>https://example.com/external</loc></url></urlset>`,
    );
  if (path === "/bad.xml") return xml("<urlset><url>");
  if (path === "/foreign.xml") {
    res.writeHead(302, { location: "https://example.com/sitemap.xml" });
    return res.end();
  }
  if (path === "/large.xml") return xml("x".repeat(1024 * 1024 + 1));
  if (path === "/canonical") {
    res.writeHead(302, { location: "/canonical/" });
    return res.end();
  }
  if (path === "/text.txt") {
    res.setHeader("content-type", "text/plain");
    return res.end("plain text");
  }
  if (path === "/error") {
    res.writeHead(500, { "content-type": "text/html" });
    return res.end(document(path));
  }
  if (path === "/http-private") {
    res.writeHead(308, { location: "/http-private/" });
    return res.end();
  }
  if (path === "/http-private/" && !existsSync(".fixture-auth")) {
    res.writeHead(302, { location: "/login" });
    return res.end();
  }
  res.setHeader("content-type", "text/html");
  if (path === "/client-private" && !existsSync(".fixture-auth"))
    return res.end(
      document(
        path,
        '<script>setTimeout(()=>location.href="/sign-in", 10)</script>',
      ),
    );
  if (path === "/login" || path === "/sign-in")
    return res.end(
      document(path, '<label>Password<input type="password"></label>'),
    );
  if (path === "/")
    return res.end(
      document(
        path,
        '<a href="/section">Section</a><a href="/http-private/">Private</a><a href="/client-private">Client</a><a href="/login">Login</a><a href="/canonical">Canonical</a><a href="https://example.com/external">External</a><a href="/download" download>Download</a>',
      ),
    );
  if (path === "/section")
    return res.end(
      document(
        path,
        '<base href="/section/"><a href="item/observed">Item</a><a href="/">Home</a>',
      ),
    );
  if (path === "/many")
    return res.end(
      document(
        path,
        Array.from(
          { length: 100 },
          (_, i) => `<a href="/limit-${i}">Link</a>`,
        ).join(""),
      ),
    );
  return res.end(document(path));
});
server.listen(port, "127.0.0.1", () => console.log(`READY ${port}`));
