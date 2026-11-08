import { createServer } from "node:http";
export const html = (radius) =>
  `<!doctype html><html lang="en"><head><title>Decision fixture</title><style>h1{border-radius:${radius}px;background:#eee;width:200px;padding:24px}</style></head><body><main><h1 data-idiom-name="title">Hello</h1></main></body></html>`;
createServer((_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.end(html(8));
}).listen(Number(process.env.PORT), "127.0.0.1");
