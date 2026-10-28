import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const page = `<!doctype html><html lang="en"><head><title>Orders</title>
<style>body{font:16px sans-serif;margin:24px}</style></head><body>
<main><h1>Orders</h1>
<button id="load" type="button">Load orders</button>
<button id="show-a" type="button">Show archived</button>
<button id="show-b" type="button">Show drafts</button>
<ul id="list"></ul><p id="panel"></p></main>
<script>
document.querySelector("#load").addEventListener("click", async () => {
  // Include the run origin in the derived request path to expose port leaks.
  const endpoint = (location.pathname === "/" ? "" : location.pathname) + "/api/slow-step"
    + (location.search === "?submit" ? "/" + location.origin : "");
  if (location.search === "?submit") fetch(endpoint, { method: "POST" }).catch(() => {});
  const response = await fetch(endpoint);
  if (!response.ok) return;
  const items = await response.json();
  document.querySelector("#list").innerHTML = items.map((item) => "<li>" + item + "</li>").join("");
});
document.querySelector("#show-a").addEventListener("click", () => { document.querySelector("#panel").textContent = "Archived"; });
document.querySelector("#show-b").addEventListener("click", () => { document.querySelector("#panel").textContent = "Drafts"; });
</script></body></html>`;

createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (process.env.SERVER_LOG)
    appendFileSync(
      process.env.SERVER_LOG,
      `${Date.now()} ${request.method} ${url.pathname}\n`,
    );
  if (url.pathname.includes("/api/slow-step")) {
    response.writeHead(200, { "content-type": "application/json" });
    return response.end(JSON.stringify(["Order 1", "Order 2"]));
  }
  response.writeHead(200, { "content-type": "text/html" });
  response.end(page);
}).listen(Number(process.env.PORT), "127.0.0.1");
