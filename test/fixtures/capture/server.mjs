import { createServer } from "node:http";

const port = Number(process.env.PORT);
const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/plain" });
  response.end("ready");
});
server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => {
  if (process.env.IGNORE_TERM !== "1") server.close(() => process.exit(0));
});
process.on("SIGINT", () => server.close(() => process.exit(0)));
