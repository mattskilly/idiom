import { join } from "node:path";
import { expect, test } from "vitest";
import { collectChanges } from "../src/changed/git.js";
import { selectChangedStates } from "../src/changed/select.js";
import { discoverRouteEntries } from "../src/coverage/routes.js";
import { flowSchema } from "../src/schemas/flow.js";
import { validateProject } from "../src/validation.js";
import { changedFixture } from "./changed-support.js";

async function select(f: Awaited<ReturnType<typeof changedFixture>>) {
  const validated = await validateProject({ project: f.directory });
  return selectChangedStates(
    f.directory,
    validated.flows.map((record) => record.flow),
    await collectChanges(f.directory),
  );
}
const ids = (result: Awaited<ReturnType<typeof select>>) =>
  result.selected.map((state) => state.state);

test("route edits, nearest owners and transitive consumers union without swallowing nested routes", async () => {
  const f = await changedFixture({
    "app/page.tsx": "export default 1",
    "app/r0/ui/Card.tsx": "export default 1",
    "app/r1/page.tsx": "export { default } from '../../shared/barrel'",
    "shared/barrel.ts": "export { default } from '../app/r0/ui/Card'",
  });
  try {
    await f.write("app/r0/page.tsx", "export default 2");
    expect(ids(await select(f))).toEqual(["s0"]);
    await f.git("checkout", "--", "app/r0/page.tsx");
    await f.write("app/r0/ui/Card.tsx", "export default 2");
    const selection = await select(f);
    expect(ids(selection)).toEqual(["s0", "s1"]);
    expect(selection.files[0]?.importChains?.[0]).toEqual([
      "app/r1/page.tsx",
      "shared/barrel.ts",
      "app/r0/ui/Card.tsx",
    ]);
    await f.git("checkout", "--", "app/r0/ui/Card.tsx");
    await f.write("app/components/new.ts", "export default 1");
    expect((await select(f)).files[0]?.kind).toBe("unresolved");
  } finally {
    await f.cleanup();
  }
});

test("inherited aliases, JS specifiers backed by TS, directory indexes and cycles resolve", async () => {
  const f = await changedFixture({
    "tsconfig.base.json":
      '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["shared/*"]}}}',
    "tsconfig.json": '{"extends":"./tsconfig.base.json"}',
    "app/r0/page.tsx": "import { x } from '@/index'; export default x;",
    "shared/index.ts": "export { x } from './value.js'",
    "shared/value.ts": "import './index'; export const x = 1;",
  });
  try {
    await f.write("shared/value.ts", "import './index'; export const x = 2;");
    const selection = await select(f);
    expect(ids(selection)).toEqual(["s0"]);
    expect(selection.files[0]?.kind).toBe("import");
  } finally {
    await f.cleanup();
  }
});

test.each([
  "DESIGN.md",
  "app/layout.tsx",
  "src/tokens.json",
  "tailwind.config.ts",
  "app/globals.css",
  ".idiom/design.json",
])("global %s selects every candidate with a named reason", async (path) => {
  const f = await changedFixture();
  try {
    await f.write(path, path.endsWith("json") ? "{}" : "");
    const selection = await select(f);
    expect(ids(selection)).toEqual(["s0", "s1"]);
    expect(selection.files[0]).toMatchObject({ path, kind: "global" });
    expect(selection.fallbackFiles).toEqual([path]);
  } finally {
    await f.cleanup();
  }
});

test("a global layout dependency broadens while CSS modules stay route-scoped", async () => {
  const f = await changedFixture({
    "app/layout.tsx": "import '../shared/palette'; export default 1",
    "shared/palette.ts": "export const color = 'red'",
    "app/r0/page.tsx": "import './card.module.css'; export default 1",
    "app/r0/card.module.css": ".card {}",
  });
  try {
    await f.write("app/r0/card.module.css", ".card { color: red }");
    expect(ids(await select(f))).toEqual(["s0"]);
    await f.git("checkout", "--", "app/r0/card.module.css");
    await f.write("shared/palette.ts", "export const color = 'blue'");
    expect((await select(f)).files[0]?.kind).toBe("global");
  } finally {
    await f.cleanup();
  }
});

test.each([
  ["import './missing'; export default 1", "unresolved import"],
  ["export default (", "malformed source"],
  ["const name = 'x'; import(name); export default 1", "nonliteral"],
  [
    "const files = import.meta.glob('./**/*.tsx'); export default files",
    "nonliteral",
  ],
])(
  "uncertain graph edges add only the routes that reach them: %s",
  async (source, reason) => {
    const f = await changedFixture({ "app/r0/page.tsx": source }, 3);
    try {
      await f.write("app/r1/ui.ts", "export default 1");
      const selection = await select(f);
      expect(ids(selection)).toEqual(["s0", "s1"]);
      expect(selection.fallbackFiles).toEqual([]);
      expect(selection.files[0]?.uncertainties?.join("\n")).toContain(reason);
    } finally {
      await f.cleanup();
    }
  },
);

test("an uncertain edge in a global module or configuration falls back to every state", async () => {
  const f = await changedFixture(
    { "app/layout.tsx": "import './missing'; export default 1" },
    3,
  );
  try {
    await f.write("app/r1/page.tsx", "export default 2");
    let selection = await select(f);
    expect(ids(selection)).toEqual(["s0", "s1", "s2"]);
    expect(selection.files[0]?.reason).toContain("unresolved import");
    await f.write("app/layout.tsx", "export default 1");
    await f.write("tsconfig.json", '{"compilerOptions": {"paths": 3}}');
    await f.commit();
    await f.write("app/r1/page.tsx", "export default 3");
    selection = await select(f);
    expect(selection.fallbackFiles).toEqual(["app/r1/page.tsx"]);
    expect(selection.files[0]?.reason).toContain("configuration");
  } finally {
    await f.cleanup();
  }
});

test("runtime builtins are external, not unresolved imports", async () => {
  const f = await changedFixture(
    {
      "app/r0/page.tsx":
        "import { readFile } from 'node:fs/promises'; import path from 'path'; export default 1",
    },
    3,
  );
  try {
    await f.write("app/r0/page.tsx", "import 'node:fs'; export default 2");
    const selection = await select(f);
    expect(ids(selection)).toEqual(["s0"]);
    expect(selection.files[0]?.uncertainties).toBeUndefined();
  } finally {
    await f.cleanup();
  }
});

test("deleted shared sources fall back; deleted routes retain path ownership and empty diffs select nothing", async () => {
  const f = await changedFixture({
    "shared.ts": "export default 1",
    "app/r0/page.tsx": "export { default } from '../../shared'",
  });
  try {
    expect(ids(await select(f))).toEqual([]);
    await f.git("rm", "shared.ts");
    expect((await select(f)).fallbackFiles).toEqual(["shared.ts"]);
    await f.git("reset", "--hard", "HEAD");
    await f.git("rm", "app/r0/page.tsx");
    expect(ids(await select(f))).toEqual(["s0"]);
  } finally {
    await f.cleanup();
  }
});

test.each([
  ["next", "app/(group)/r0/page.tsx", "/r0/?q=1#top", "/r0"],
  ["next", "pages/r0/[id].tsx", "/r0/12", "/r0/[id]"],
  ["astro", "src/pages/r0/[...rest].astro", "/r0/a/b", "/r0/[...rest]"],
  [
    "@sveltejs/kit",
    "src/routes/(group)/r0/[[lang]]/[id=number]/+page.svelte",
    "/r0/12",
    "/r0/[[lang]]/[id]",
  ],
  ["@remix-run/react", "app/routes/_auth.r0.$id.tsx", "/r0/12", "/r0/[id]"],
  [
    "@remix-run/react",
    "app/routes/r0_.$/route.tsx",
    "/r0/a/b",
    "/r0/[...rest]",
  ],
  ["@remix-run/react", "app/routes/r0._index.tsx", "/r0", "/r0"],
])(
  "%s topology maps %s and keeps duplicate URL sources",
  async (pkg, path, url, route) => {
    const source = path.endsWith("svelte")
      ? "<script>export let value = 1;</script><main />"
      : path.endsWith("astro")
        ? "---\nconst value = 1;\n---\n<main />"
        : "export default 1";
    const f = await changedFixture({
      "package.json": JSON.stringify({ dependencies: { [pkg]: "1" } }),
      [path]: source,
    });
    try {
      const flow = flowSchema.parse({
        id: "routes",
        title: "Routes",
        setup: [],
        intent: [],
        states: [
          { id: "match", description: "Match", url, expect: {} },
          { id: "other", description: "Other", url: "/other", expect: {} },
        ],
      });
      const entries = await discoverRouteEntries(f.directory);
      expect(entries).toContainEqual({ source: path, route });
      const changes = await collectChanges(f.directory);
      changes.files = [{ path, absolute: join(changes.repository, path) }];
      const selection = await selectChangedStates(f.directory, [flow], changes);
      expect(ids(selection)).toEqual(["match"]);
    } finally {
      await f.cleanup();
    }
  },
);

test("states with dynamic URLs join every source edit without broadening mapped states", async () => {
  const f = await changedFixture({}, 3);
  try {
    const { flows } = await validateProject({ project: f.directory });
    const flow = flows[0]?.flow;
    if (flow?.target.kind !== "web") throw new Error("missing fixture flow");
    // The same shape validation produces for urlFrom.
    const unknown = {
      ...flow,
      states: flow.states.map((state, index) =>
        index === 0 ? { ...state, url: undefined } : state,
      ),
    } as typeof flow;
    await f.write("app/r1/page.tsx", "export default 2");
    const selection = await selectChangedStates(
      f.directory,
      [unknown],
      await collectChanges(f.directory),
    );
    expect(ids(selection)).toEqual(["s0", "s1"]);
    expect(selection.fallbackFiles).toEqual([]);
    expect(selection.files[0]?.uncertainties?.[0]).toContain("URL or target");
  } finally {
    await f.cleanup();
  }
});

test.each(["svelte", "astro"])(
  "%s script imports trace shared source dependencies",
  async (format) => {
    const f = await changedFixture({
      "package.json": JSON.stringify({
        dependencies: { [format === "astro" ? "astro" : "@sveltejs/kit"]: "1" },
      }),
      [format === "astro"
        ? "src/pages/r0.astro"
        : "src/routes/r0/+page.svelte"]:
        format === "astro"
          ? "---\nimport {value} from '../shared/value';\n---\n<main>{value}</main>"
          : "<script lang='ts'>import {value} from '../../shared/value';</script><main>{value}</main>",
      "src/shared/value.ts": "export const value = 1",
    });
    try {
      await f.write("src/shared/value.ts", "export const value = 2");
      expect(ids(await select(f))).toEqual(["s0"]);
    } finally {
      await f.cleanup();
    }
  },
);

test("Remix parent layouts and malformed configuration force explained all-state selection", async () => {
  const f = await changedFixture({
    "package.json": '{"dependencies":{"@remix-run/react":"1"}}',
    "app/routes/r0.tsx": "export default 1",
    "app/routes/r0.child.tsx": "export default 1",
  });
  try {
    await f.write("app/routes/r0.tsx", "export default 2");
    expect((await select(f)).files[0]?.kind).toBe("global");
    await f.git("checkout", "--", "app/routes/r0.tsx");
    await f.write("tsconfig.json", "{ broken");
    await f.commit();
    await f.write("app/routes/r0.child.tsx", "export default 2");
    expect((await select(f)).files[0]?.reason).toContain("cannot parse");
  } finally {
    await f.cleanup();
  }
});

test("a changed route selects its chained and expanded toggle states", async () => {
  const f = await changedFixture();
  try {
    await f.write(
      ".idiom/flows/site.json",
      JSON.stringify({
        id: "site",
        title: "Site",
        intent: [],
        setup: [],
        states: [
          { id: "home", description: "Home", url: "/r0", expect: {} },
          {
            id: "next",
            description: "Next",
            from: "home",
            steps: [{ action: "click", selector: "button" }],
            expect: {},
          },
          { id: "other", description: "Other", url: "/r1", expect: {} },
        ],
        toggles: { search: { focused: [{ action: "focus", selector: "#q" }] } },
        toggleStates: ["next"],
      }),
    );
    await f.commit();
    await f.write("app/r0/page.tsx", "export default 2");
    expect(ids(await select(f))).toEqual([
      "home",
      "next",
      "next.search-focused",
    ]);
  } finally {
    await f.cleanup();
  }
});

test("installed framework imports remain external leaves even with baseUrl", async () => {
  const f = await changedFixture({
    "tsconfig.json": '{"compilerOptions":{"baseUrl":"."}}',
    "node_modules/react/package.json": '{"name":"react","main":"index.js"}',
    "node_modules/react/index.js":
      "require('./not-crawled'); module.exports = {};",
    "app/r0/page.tsx": "import React from 'react'; export default React;",
  });
  try {
    await f.write(
      "app/r0/page.tsx",
      "import React from 'react'; export default React.Fragment;",
    );
    expect(ids(await select(f))).toEqual(["s0"]);
  } finally {
    await f.cleanup();
  }
});

test("Svelte directory indexes resolve inherited aliases without baseUrl", async () => {
  const f = await changedFixture({
    "tsconfig.base.json":
      '{"compilerOptions":{"paths":{"$lib/*":["./src/lib/*"]}}}',
    "src/routes/tsconfig.json": '{"extends":"../../tsconfig.base.json"}',
    "src/routes/r0/+page.svelte":
      '<script>import Widget from "$lib/Widget";</script><Widget />',
    "src/lib/Widget/index.svelte": "<main>Before</main>",
  });
  try {
    await f.write("src/lib/Widget/index.svelte", "<main>After</main>");
    expect(ids(await select(f))).toEqual(["s0"]);
  } finally {
    await f.cleanup();
  }
});

test("Remix trailing-underscore escapes do not turn an unrelated parent page into a layout", async () => {
  const f = await changedFixture({
    "package.json": '{"dependencies":{"@remix-run/react":"1"}}',
    "app/routes/r0.tsx": "export default 1",
    "app/routes/r0_.child.tsx": "export default 1",
  });
  try {
    await f.write("app/routes/r0.tsx", "export default 2");
    const selection = await select(f);
    expect(selection.files[0]?.kind).toBe("route");
    expect(ids(selection)).toEqual(["s0"]);
  } finally {
    await f.cleanup();
  }
});
