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
  if (path.startsWith("/missing")) {
    res.writeHead(404, { "content-type": "text/html" });
    return res.end(document(path, '<input type="password">'));
  }
  if (path === "/http-missing") {
    res.writeHead(302, { location: "/missing/login" });
    return res.end();
  }
  if (path === "/client-missing") {
    res.setHeader("content-type", "text/html");
    return res.end(
      document(
        path,
        '<script>setTimeout(()=>location.href="/missing-client",10)</script>',
      ),
    );
  }
  if (path === "/resource-control") {
    res.setHeader("content-type", "text/html");
    return res.end(
      document(
        path,
        '<iframe src="/missing-frame"></iframe><img src="/missing-image">',
      ),
    );
  }
  if (path === "/status-index") {
    res.setHeader("content-type", "text/html");
    return res.end(
      document(
        path,
        [
          "missing-direct",
          "http-missing",
          "client-missing",
          "resource-control",
          "_public/utils/private",
        ]
          .map((p) => `<a href="/${p}">${p}</a>`)
          .join(""),
      ),
    );
  }
  if (path === "/og.png" || path === "/image") {
    res.setHeader("content-type", "image/png");
    return res.end(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
        "base64",
      ),
    );
  }
  if (path === "/data") {
    res.setHeader("content-type", "application/json; charset=utf-8");
    return res.end('{"message":"Expected data"}');
  }
  if (path === "/feed" || path === "/xml") {
    res.setHeader(
      "content-type",
      path === "/xml" ? "application/xml" : "application/rss+xml",
    );
    return res.end(
      path === "/xml"
        ? '<?xml version="1.0"?><root><item>Expected XML</item></root>'
        : '<?xml version="1.0"?><rss version="2.0"><channel><title>Expected feed</title></channel></rss>',
    );
  }
  if (path === "/mime-redirect") {
    res.writeHead(302, { location: "/image" });
    return res.end();
  }
  if (path === "/mime-client") {
    res.setHeader("content-type", "text/html");
    return res.end(document(path, '<script>location.href="/data"</script>'));
  }
  if (path === "/mime-index") {
    res.setHeader("content-type", "text/html");
    return res.end(
      document(
        path,
        ["image", "data", "feed", "mime-redirect", "mime-client", "no-h1"]
          .map((p) => `<a href="/${p}">${p}</a>`)
          .join(""),
      ),
    );
  }
  if (path === "/no-h1" || path === "/multiple-h1") {
    res.setHeader("content-type", "text/html");
    return res.end(
      `<!doctype html><html lang="en"><title>Heading control</title><body><main>${path === "/no-h1" ? "Expected HTML text" : "<h1>First</h1><h1>Second</h1>"}</main></body></html>`,
    );
  }
  if (path === "/slow") return setTimeout(() => res.end(document(path)), 500);
  if (path === "/set-cookie")
    res.setHeader("set-cookie", "session=authenticated; Path=/");
  if (path === "/cookie-check" && req.headers.cookie)
    return res.end(document(path, '<input type="password">'));
  if (path === "/sitemap.xml" && existsSync(".fixture-status"))
    return xml(
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/missing-sitemap</loc></url><url><loc>${origin}/missing-direct</loc></url></urlset>`,
    );
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
