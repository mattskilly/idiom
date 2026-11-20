import { createServer } from "node:http";

// Four pages share a header Menu control and each has its own action, a
// faint note and a heading. `/slow` answers after SLOW_MS, so a test can
// exceed capture.stateMaxMinutes on one state without guessing timing.
const page = (title) =>
  `<!doctype html><html lang="en"><head><title>${title}</title><style>body{font:16px sans-serif;margin:24px;color:#1a1a1a;background:#fff}.faint{color:#c8c8c8}button{font:inherit;padding:8px 12px}</style></head><body><header><nav><button id="menu" type="button" aria-expanded="false" onclick="this.setAttribute('aria-expanded', String(this.getAttribute('aria-expanded') !== 'true'))">Menu</button></nav></header><main><h1>${title}</h1><p class="faint">A faint ${title.toLowerCase()} note</p><button id="act" type="button" onclick="document.getElementById('out').textContent='${title} done'">Do ${title}</button><p id="out"></p></main></body></html>`;
const server = createServer((request, response) => {
  const path = (request.url ?? "/").split("?")[0];
  const send = () => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      page(
        path === "/"
          ? "Home"
          : path.slice(1).replace(/^./, (c) => c.toUpperCase()),
      ),
    );
  };
  if (path === "/slow") {
    const timer = setTimeout(send, Number(process.env.SLOW_MS ?? 0));
    request.on("close", () => clearTimeout(timer));
    return;
  }
  send();
});
server.listen(Number(process.env.PORT), "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
