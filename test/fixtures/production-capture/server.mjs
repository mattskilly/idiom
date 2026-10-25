import { appendFile, readFile } from "node:fs/promises";
import { createServer } from "node:http";

const production = process.argv[2] === "production";
if (production) {
  const snapshot = JSON.parse(
    await readFile(`${process.env.OUTPUT_DIR}/snapshot.json`, "utf8"),
  );
  if (
    snapshot.port !== process.env.PORT ||
    snapshot.data !== process.env.DATA_DIR ||
    snapshot.api !== process.env.NEXT_PUBLIC_API_BASE
  )
    throw new Error("build and start environments differ");
}
const marker = await readFile(`${process.env.DATA_DIR}/marker`, "utf8").catch(
  () => undefined,
);
await appendFile(
  process.env.AUDIT_FILE,
  `${JSON.stringify({ phase: "start", marker, pid: process.pid, port: process.env.PORT, data: process.env.DATA_DIR })}\n`,
);
const server = createServer(async (req, res) => {
  if (process.env.FAIL_READY === "1") {
    res.statusCode = 503;
    return res.end("not ready");
  }
  if (req.url === "/api") return res.end("CLIENT API OK");
  if (!production) return res.end("<h1>DEVELOPMENT MARKER</h1>");
  res.setHeader(
    "Content-Type",
    req.url === "/client.js" ? "application/javascript" : "text/html",
  );
  res.end(
    await readFile(
      `${process.env.OUTPUT_DIR}/${req.url === "/client.js" ? "client.js" : "index.html"}`,
    ),
  );
});
server.listen(Number(process.env.PORT), "127.0.0.1");
if (process.env.IGNORE_TERM === "1") process.on("SIGTERM", () => {});
else process.on("SIGTERM", () => server.close(() => process.exit(0)));
