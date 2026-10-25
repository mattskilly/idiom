import { appendFile, readFile } from "node:fs/promises";
import { createServer } from "node:http";

const pages = {
  "/": "start.html",
  "/shell-before": "../shell-visibility/before.html",
  "/shell-after": "../shell-visibility/after.html",
  "/visibility-navigation": "visibility-navigation.html",
  "/templates": "templates.html",
  "/editor": "editor.html",
  "/toggles": "toggles.html",
  "/combination-evidence": "combination-evidence.html",
  "/probe": "probe.html",
  "/text-expectations": "text-expectations.html",
  "/slow-action": "slow-action.html",
  "/shadow-text": "shadow-text.html",
  "/versions": "versions.html",
};
let nextCount = 0;
const server = createServer(async (request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;
  if (path === "/next-count") {
    response.end(String(nextCount));
  } else if (pages[path]) {
    response.setHeader("Content-Type", "text/html");
    response.end(await readFile(new URL(pages[path], import.meta.url)));
  } else if (path === "/broken") {
    // Deliberately later than the click handler and Playwright's click promise.
    setTimeout(() => {
      response.writeHead(500);
      response.end("template create failed");
    }, 150);
  } else if (path === "/missing") {
    response.writeHead(404);
    response.end("expected missing resource");
  } else if (path === "/log") {
    response.end("accepted");
    setTimeout(() => {
      void appendFile(process.env.SERVER_LOG, "ERROR delayed server failure\n");
    }, 100);
  } else if (path === "/pending") {
    // Body never completes, even though headers have arrived.
    response.writeHead(200);
    response.write("pending");
  } else {
    if (path === "/next") nextCount++;
    response.end("ok");
  }
});
server.listen(Number(process.env.PORT), "127.0.0.1");
