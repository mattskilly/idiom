import { createServer } from "node:http";

const server = createServer((_request, response) => {
  response.setHeader("content-type", "text/html");
  response.end(`<!doctype html><html lang="en"><title>Polish fixture</title><style>
  body{font:16px sans-serif;margin:30px}button{width:12px;height:12px;padding:0;border:1px solid black;margin-right:2px}
  </style><h1>Polish fixture</h1><main><section aria-label="Actions">
  <button data-idiom-name="SharedAction" aria-label="Continue" onclick="document.querySelector('output').textContent='Done'">+</button><button aria-label="More" onclick="document.querySelector('output').textContent='More'">+</button><output></output>
  </section></main></html>`);
});
server.listen(Number(process.env.PORT), "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
