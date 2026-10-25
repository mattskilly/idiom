import { appendFile, mkdir, writeFile } from "node:fs/promises";

const output = process.env.OUTPUT_DIR;
await mkdir(output, { recursive: true });
const snapshot = {
  port: process.env.PORT,
  data: process.env.DATA_DIR,
  api: process.env.NEXT_PUBLIC_API_BASE,
  secret: process.env.SESSION_SECRET,
};
await appendFile(
  process.env.AUDIT_FILE,
  `${JSON.stringify({ phase: "build", pid: process.pid, ...snapshot })}\n`,
);
await writeFile(`${output}/snapshot.json`, JSON.stringify(snapshot));
await writeFile(
  `${output}/index.html`,
  `<!doctype html><html lang="en"><head><title>Production fixture</title></head><body><main><h1>PRODUCTION MARKER</h1><p id="client">waiting</p>${snapshot.secret ? `<input type="hidden" value="${snapshot.secret}">` : ""}<script src="/client.js"></script></main></body></html>`,
);
await writeFile(
  `${output}/client.js`,
  `fetch(${JSON.stringify(`${snapshot.api}/api`)}).then(r => r.text()).then(text => document.querySelector('#client').textContent = text);`,
);
if (process.env.WRITE_BUILD_ID !== "0")
  await writeFile(`${output}/BUILD_ID`, " fixture-production-id\n");
if (process.env.FAIL_BUILD === "1") process.exit(7);
if (process.env.HANG_BUILD === "1") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
}
