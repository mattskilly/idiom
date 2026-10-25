import { createServer } from "node:http";

const port = Number(process.env.PORT);
const marker = process.env.MARKER ?? "unmarked";
const server = createServer((request, response) => {
  const own = `http://127.0.0.1:${port}${request.url}`;
  const page = (status, body) => {
    response.writeHead(status, { "content-type": "text/html" });
    response.end(
      `<!doctype html><html lang="en"><head><title>${marker}</title></head><body><main><h1>Port fixture</h1>${body}</main><script>console.error(${JSON.stringify(`failure at ${own}`)});</script></body></html>`,
    );
  };
  if (request.url === "/missing")
    return page(404, `<p id="who">${marker} missing on ${port}</p>`);
  page(200, `<p id="who">${marker} on ${port}</p>`);
});
server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
