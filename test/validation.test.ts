import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { initProject } from "../src/commands/init.js";
import {
  loadProjectContext,
  validateNamedFlow,
  validateProject,
  validateProjectConfiguration,
} from "../src/validation.js";

const temporaryDirectories: string[] = [];

async function project(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "idiom-validation-"));
  temporaryDirectories.push(directory);
  await initProject({ project: directory, yes: true });
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function flow(id: string, viewports?: string[]) {
  return {
    id,
    title: id,
    intent: ["It works."],
    setup: [{ run: "must-never-execute", captureStdout: true }],
    states: [
      {
        id: "home",
        description: "Home",
        url: "/?tz=America/New_York",
        expect: {},
      },
    ],
    ...(viewports === undefined ? {} : { viewports }),
  };
}

async function writeFlow(
  directory: string,
  id: string,
  value = flow(id),
): Promise<void> {
  await writeFile(
    join(directory, ".idiom", "flows", `${id}.json`),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

test("validates a named flow and discovers its project upward", async () => {
  const directory = await project();
  await writeFlow(directory, "booking");
  const nested = join(directory, "apps", "web");
  await mkdir(nested, { recursive: true });
  const result = await validateProject({ cwd: nested, flow: "booking" });
  expect(result.projectDirectory).toBe(directory);
  expect(result.flows.map(({ flow: manifest }) => manifest.id)).toEqual([
    "booking",
  ]);
});

test("validates every flow in deterministic filename order", async () => {
  const directory = await project();
  await writeFlow(directory, "zeta");
  await writeFlow(directory, "alpha");
  const result = await validateProject({ project: directory });
  expect(result.flows.map(({ flow: manifest }) => manifest.id)).toEqual([
    "alpha",
    "zeta",
  ]);
});

test("reports nested schema errors with the file and exact field path", async () => {
  const directory = await project();
  await writeFlow(directory, "broken", flow("broken"));
  const manifest = flow("broken") as Record<string, unknown>;
  manifest.states = [
    {
      id: "home",
      description: "Home",
      urlFrom: { source: "setup-stdout", pattern: "no capture" },
      expect: {},
    },
  ];
  await writeFlow(directory, "broken", manifest as ReturnType<typeof flow>);
  await expect(
    validateProject({ project: directory, flow: "broken" }),
  ).rejects.toThrow(".idiom/flows/broken.json: states[0].urlFrom.pattern");
});

test("reports an unknown from state at its exact path (#57)", async () => {
  const directory = await project();
  const manifest = flow("broken") as Record<string, unknown>;
  manifest.states = [
    { id: "empty", description: "Empty", url: "/", expect: {} },
    { id: "versions", description: "Versions", from: "history", expect: {} },
  ];
  await writeFlow(directory, "broken", manifest as ReturnType<typeof flow>);
  await expect(
    validateProject({ project: directory, flow: "broken" }),
  ).rejects.toThrow(
    '.idiom/flows/broken.json: states[1].from: unknown state "history"',
  );
});

test("reports a ported Electron HTTP expectation at its exact path", async () => {
  const directory = await project();
  await writeFlow(directory, "desktop", {
    id: "desktop",
    title: "Desktop",
    intent: [],
    setup: [],
    target: {
      kind: "electron",
      launch: { executablePath: "electron" },
      window: { title: "Capture" },
    },
    states: [
      {
        id: "settings",
        description: "Settings",
        steps: [],
        expect: { status: 200 },
      },
    ],
  } as unknown as ReturnType<typeof flow>);
  await expect(
    validateProject({ project: directory, flow: "desktop" }),
  ).rejects.toThrow(
    ".idiom/flows/desktop.json: states[0].expect.status: unrecognized field",
  );
});

test("reports an unknown Electron step action at its exact path", async () => {
  const directory = await project();
  await writeFlow(directory, "desktop", {
    id: "desktop",
    title: "Desktop",
    intent: [],
    setup: [],
    target: {
      kind: "electron",
      launch: { executablePath: "electron" },
      window: { title: "Capture" },
    },
    states: [
      {
        id: "settings",
        description: "Settings",
        steps: [{ action: "type", selector: "#account-name" }],
        expect: {},
      },
    ],
  } as unknown as ReturnType<typeof flow>);
  await expect(
    validateProject({ project: directory, flow: "desktop" }),
  ).rejects.toThrow(
    ".idiom/flows/desktop.json: states[0].steps[0].action: Invalid discriminator value. Expected 'click' | 'fill' | 'press'",
  );
});

test("distinguishes malformed JSON, missing flows, empty directories, and unknown viewports", async () => {
  const directory = await project();
  await expect(validateProject({ project: directory })).rejects.toThrow(
    "no flow manifests found",
  );
  await expect(
    validateProject({ project: directory, flow: "missing" }),
  ).rejects.toThrow(".idiom/flows/missing.json: file not found");

  await writeFile(join(directory, ".idiom", "flows", "bad.json"), "{ nope");
  await expect(
    validateProject({ project: directory, flow: "bad" }),
  ).rejects.toThrow("malformed JSON");

  await writeFlow(directory, "viewport", flow("viewport", ["tablet"]));
  await expect(
    validateProject({ project: directory, flow: "viewport" }),
  ).rejects.toThrow('viewports[0]: unknown project viewport "tablet"');
});

test("reports malformed and missing project configuration separately", async () => {
  const directory = await project();
  const projectFile = join(directory, ".idiom", "project.json");
  await writeFile(projectFile, "{ broken");
  await expect(
    validateProject({ project: directory, flow: "anything" }),
  ).rejects.toThrow(".idiom/project.json: malformed JSON");

  await rm(projectFile);
  await expect(
    validateProject({ project: directory, flow: "anything" }),
  ).rejects.toThrow("no .idiom/project.json found");
});

test("surface-aware validation checks every flow while legacy named validation stays isolated", async () => {
  const directory = await project();
  await writeFlow(directory, "booking", {
    ...flow("booking"),
    surface: "recipient",
  } as ReturnType<typeof flow>);
  await writeFlow(directory, "composer", flow("composer"));
  const projectFile = join(directory, ".idiom", "project.json");
  const configuration = JSON.parse(await readFile(projectFile, "utf8"));
  await writeFile(
    projectFile,
    `${JSON.stringify({
      ...configuration,
      surfaces: [
        { id: "recipient", name: "Recipient booking" },
        { id: "composer", name: "Desktop composer" },
      ],
    })}\n`,
  );
  await expect(
    validateProject({ project: directory, flow: "booking" }),
  ).rejects.toThrow("composer.json: surface: required");

  await writeFlow(directory, "composer", {
    ...flow("composer"),
    surface: "unknown",
  } as ReturnType<typeof flow>);
  await expect(
    validateProject({ project: directory, flow: "booking" }),
  ).rejects.toThrow('unknown project surface "unknown"');

  await writeFlow(directory, "composer", {
    ...flow("composer"),
    surface: "composer",
  } as ReturnType<typeof flow>);
  await expect(
    validateProject({ project: directory, flow: "booking" }),
  ).resolves.toMatchObject({ flows: [{ flow: { id: "booking" } }] });
});

test("production defaults require project configuration with actionable guidance", async () => {
  const directory = await project();
  await writeFile(
    join(directory, ".idiom", "flows", "prod.json"),
    JSON.stringify({ ...flow("prod"), server: "production" }),
  );
  await expect(
    validateProject({ project: directory, flow: "prod" }),
  ).rejects.toThrow(
    /flows\/prod.json: server:.*server.production.*"build".*"start"/s,
  );
  const path = join(directory, ".idiom", "project.json");
  const config = JSON.parse(await readFile(path, "utf8"));
  config.server.production = { build: "npm run build", start: "npm start" };
  await writeFile(path, JSON.stringify(config));
  expect(
    (await validateProject({ project: directory, flow: "prod" })).flows[0]
      ?.flow,
  ).toMatchObject({ server: "production" });
});

function publishedFlow(extra: Record<string, unknown> = {}) {
  return {
    id: "site",
    title: "Site",
    intent: [],
    setup: [],
    kind: "published",
    pages: ["/p/a"],
    ...extra,
  };
}

async function writePublished(
  directory: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await writeFile(
    join(directory, ".idiom", "flows", "site.json"),
    JSON.stringify(publishedFlow(extra)),
  );
}

test("a published flow without viewports captures 1280/768/375 on a desktop/mobile project", async () => {
  const directory = await project();
  await writePublished(directory);
  const parsed = (await validateProject({ project: directory, flow: "site" }))
    .flows[0]?.flow;
  expect(parsed?.viewports).toEqual(["1280", "768", "375"]);
  expect(parsed?.states.map(({ id, url }) => ({ id, url }))).toEqual([
    { id: "page-p-a", url: "/p/a" },
  ]);
  expect(parsed && "viewportSizes" in parsed && parsed.viewportSizes).toEqual({
    "1280": { width: 1280, height: 800 },
    "768": { width: 768, height: 1024 },
    "375": { width: 375, height: 812 },
  });
});

test("a published flow may mix widths with project viewports, but unknown names still fail", async () => {
  const directory = await project();
  await writePublished(directory, { viewports: [1280, "desktop"] });
  await expect(
    validateProject({ project: directory, flow: "site" }),
  ).resolves.toBeDefined();
  await writePublished(directory, { viewports: ["tablet"] });
  await expect(
    validateProject({ project: directory, flow: "site" }),
  ).rejects.toThrow('unknown project viewport "tablet"');
});

test("published states may narrow to a synthesized width only", async () => {
  const directory = await project();
  const narrowed = (viewport: string) => ({
    states: [
      {
        id: "pricing",
        description: "Pricing",
        url: "/pricing",
        expect: {},
        viewports: [viewport],
      },
    ],
  });
  await writePublished(directory, narrowed("375"));
  await expect(
    validateProject({ project: directory, flow: "site" }),
  ).resolves.toBeDefined();
  await writePublished(directory, narrowed("999"));
  await expect(
    validateProject({ project: directory, flow: "site" }),
  ).rejects.toThrow("is not captured by this flow");
});

test("pages, budget and numeric viewports require kind: published", async () => {
  const directory = await project();
  for (const [extra, field] of [
    [{ pages: ["/a"] }, "pages"],
    [{ budget: { maxDiffRatio: 0.01 } }, "budget"],
    [{ viewports: [1280] }, "viewports"],
  ] as const) {
    await writeFlow(directory, "plain", {
      ...flow("plain"),
      ...extra,
    } as ReturnType<typeof flow>);
    await expect(
      validateProject({ project: directory, flow: "plain" }),
    ).rejects.toThrow(field);
  }
  await writePublished(directory, { pages: undefined });
  await expect(
    validateProject({ project: directory, flow: "site" }),
  ).rejects.toThrow('required when kind is "published"');
});

test("optional glossary file supplies copy policy at the shared boundary", async () => {
  const directory = await project();
  await writeFlow(directory, "editor");
  await writeFile(
    join(directory, ".idiom/glossary.json"),
    JSON.stringify({
      locale: "en-CA",
      retired: [{ term: "Style guide", preferred: "Brand" }],
      jargon: [{ term: "nodes", preferred: "items" }],
    }),
  );
  const result = await validateProject({ project: directory, flow: "editor" });
  expect(result.project.checks.copy).toEqual(
    expect.objectContaining({
      locale: "en-CA",
      retired: [{ term: "Style guide", preferred: "Brand" }],
      jargon: [{ term: "nodes", preferred: "items" }],
    }),
  );
});

test("copy policy merges deterministically without rewriting source files", async () => {
  const directory = await project();
  const configPath = join(directory, ".idiom/project.json");
  const policyPath = join(directory, ".idiom/glossary.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.checks = {
    ...config.checks,
    copy: {
      locale: "en-AU",
      retired: [
        { term: "STYLE   GUIDE", preferred: "Old brand" },
        { term: "style guide", preferred: "Brand" },
      ],
      jargon: [],
      glossary: [{ term: "old", preferred: "Modern" }],
      schemaWords: ["Role", "role"],
      properNouns: ["Hero Centered"],
    },
  };
  const file = {
    locale: "en-CA",
    retired: [
      { term: "Style guide", preferred: "File brand" },
      { term: "Follow guide", preferred: "Follow brand" },
    ],
    jargon: [
      { term: "nodes", preferred: "Old items" },
      { term: "NODES", preferred: "items" },
    ],
    glossary: [{ term: "OLD", preferred: "File modern" }, { term: "legacy" }],
    schemaWords: ["role"],
    properNouns: ["Hero Centered", "hero centered"],
  };
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(policyPath, JSON.stringify(file));
  const before = await Promise.all([
    readFile(configPath, "utf8"),
    readFile(policyPath, "utf8"),
  ]);
  const nested = join(directory, "apps/web");
  await mkdir(nested, { recursive: true });
  await writeFlow(directory, "editor");
  const context = await loadProjectContext({ cwd: nested });
  expect(context.project.checks.copy).toEqual({
    locale: "en-AU",
    retired: [
      { term: "style guide", preferred: "Brand" },
      { term: "Follow guide", preferred: "Follow brand" },
    ],
    jargon: [{ term: "NODES", preferred: "items" }],
    glossary: [{ term: "old", preferred: "Modern" }, { term: "legacy" }],
    schemaWords: ["role", "Role"],
    properNouns: ["Hero Centered", "hero centered"],
  });
  expect((await validateNamedFlow(context, "editor")).flow.id).toBe("editor");
  expect(
    (await validateProjectConfiguration({ project: directory })).project.checks
      .copy,
  ).toEqual(context.project.checks.copy);
  expect(
    await Promise.all([
      readFile(configPath, "utf8"),
      readFile(policyPath, "utf8"),
    ]),
  ).toEqual(before);
});

test.each([
  undefined,
  {},
  { copy: {} },
  {
    copy: {
      retired: [],
      jargon: [],
      glossary: [],
      schemaWords: [],
      properNouns: [],
    },
  },
])(
  "file-only copy policy is not masked by project defaults or empty arrays (%j)",
  async (checks) => {
    const directory = await project();
    const configPath = join(directory, ".idiom/project.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    if (checks === undefined) delete config.checks;
    else config.checks = checks;
    await writeFile(configPath, JSON.stringify(config));
    const policy = {
      locale: "en-CA",
      retired: [{ term: "Style guide", preferred: "Brand" }],
      jargon: [{ term: "nodes", preferred: "items" }],
      glossary: [{ term: "old" }],
      schemaWords: ["Role"],
      properNouns: ["Hero Centered"],
    };
    await writeFile(
      join(directory, ".idiom/glossary.json"),
      JSON.stringify(policy),
    );
    expect(
      (await validateProjectConfiguration({ project: directory })).project
        .checks.copy,
    ).toEqual(policy);
  },
);

test("absent file preserves config-only copy policy and creates no sidecar", async () => {
  const directory = await project();
  const configPath = join(directory, ".idiom/project.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.checks = {
    copy: { locale: "en-US", jargon: [{ term: "nodes", preferred: "items" }] },
  };
  await writeFile(configPath, JSON.stringify(config));
  const before = await readFile(configPath, "utf8");
  const { project: loaded } = await validateProjectConfiguration({
    project: directory,
  });
  expect(loaded.checks.copy).toEqual({
    locale: "en-US",
    jargon: [{ term: "nodes", preferred: "items" }],
    retired: [],
    glossary: [],
    schemaWords: [],
    properNouns: [],
  });
  expect(await readFile(configPath, "utf8")).toBe(before);
  await expect(
    readFile(join(directory, ".idiom/glossary.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

test.each([
  ["{broken", "malformed JSON"],
  ["[]", "<root>"],
  ["null", "<root>"],
  ['{"locale":"fr-CA"}', "locale"],
  ['{"retired":[{"term":"old"}]}', "retired[0].preferred"],
  ['{"jargon":[{"term":" ","preferred":"items"}]}', "jargon[0].term"],
  ['{"checks":{}}', "checks"],
  [
    '{"jargon":[{"term":"nodes","preferred":"items","extra":true}]}',
    "jargon[0].extra",
  ],
])(
  "invalid copy file reports its filename and field (%s)",
  async (source, diagnostic) => {
    const directory = await project();
    await writeFile(join(directory, ".idiom/glossary.json"), source);
    await expect(
      validateProjectConfiguration({ project: directory }),
    ).rejects.toThrow(`.idiom/glossary.json: ${diagnostic}`);
  },
);

test("unreadable copy file is not silently treated as an absent policy", async () => {
  const directory = await project();
  await mkdir(join(directory, ".idiom/glossary.json"));
  await expect(
    validateProjectConfiguration({ project: directory }),
  ).rejects.toThrow(".idiom/glossary.json: could not be read");
});
