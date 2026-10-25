import { createServer } from "node:net";
import { join } from "node:path";
import { flowSchema, isWebFlow } from "../src/schemas/flow.js";
import { projectSchema } from "../src/schemas/project.js";

export async function toggleProject() {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address === "string") throw Error("no port");
  await new Promise<void>((done) => server.close(() => done()));
  const port = address.port;
  return projectSchema.parse({
    version: 1,
    app: { name: "Toggle fixture", framework: "other" },
    server: {
      build: "node -e 0",
      start: `node ${JSON.stringify(join(import.meta.dirname, "fixtures/web-flow-steps/server.mjs"))}`,
      port,
      readyUrl: `http://127.0.0.1:${port}/`,
      env: { PORT: String(port) },
    },
    viewports: [
      { name: "desktop-1280", width: 1280, height: 800 },
      { name: "wide", width: 1600, height: 900 },
    ],
    capture: { settleMs: 0 },
    checks: { probe: { enabled: false } },
    design: {},
    model: { provider: "anthropic", model: "unused" },
  });
}

export function toggleFlow(fixed = false) {
  const click = (selector: string) => [{ action: "click", selector }];
  const flow = flowSchema.parse({
    id: "panels",
    title: "Panel combinations",
    intent: [],
    setup: [],
    states: [
      {
        id: "editor",
        description: "Editor",
        url: `/toggles${fixed ? "?fixed=1" : ""}`,
        expect: {},
        probe: false,
      },
    ],
    toggles: {
      drawer: {
        closed: [],
        "360": click("#drawer-360"),
        "480": click("#drawer-480"),
      },
      inspector: {
        closed: [],
        open: click("#inspector-open"),
        hidden: click("#inspector-hide"),
      },
    },
    toggleRegions: [".drawer", ".inspector"],
    invariants: [{ name: "controls", selector: ".ed-controls", height: 64 }],
  });
  if (!isWebFlow(flow)) throw Error("expected web flow");
  return flow;
}
