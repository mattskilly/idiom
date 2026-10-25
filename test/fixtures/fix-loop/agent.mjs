import { appendFile, readFile, writeFile } from "node:fs/promises";

let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
await appendFile(
  "agent-log.jsonl",
  `${JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), prompt })}\n`,
);
const mode = process.env.FIX_STUB_MODE ?? "all";
if (mode !== "noop") {
  let html = await readFile("page.html", "utf8");
  if (mode === "one")
    html = html.replace(
      "width: 12px; height: 12px",
      "width: 100px; height: 44px",
    );
  else
    html = html.replaceAll(
      "width: 12px; height: 12px",
      "width: 100px; height: 44px",
    );
  if (mode !== "one")
    html = html.replaceAll("width:12px;height:12px", "width:100px;height:44px");
  if (mode === "regress")
    html = html.replace(
      "</main>",
      '<button id="new" aria-label="Help" style="width:23px;height:23px"></button></main>',
    );
  await writeFile("page.html", html);
}
if (process.argv.includes("--print"))
  console.log(
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Done",
    }),
  );
else console.log("Done");
if (mode === "fail") process.exitCode = 1;
