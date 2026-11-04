import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { initProject } from "../src/commands/init.js";
import { collectSetupFacts } from "../src/setup/facts.js";
import { setupPrompt } from "../src/setup/prompt.js";
import { IDIOM_VERSION } from "../src/version.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "idiom-setup-facts-"));
  directories.push(directory);
  return directory;
}

const SECRET = "sentinel-secret-9f2c";

test("an empty, uninitialized directory yields empty facts without throwing", async () => {
  const directory = await temporary();
  const facts = await collectSetupFacts(directory);
  expect(facts).toEqual({
    idiomVersion: IDIOM_VERSION,
    projectDirectory: directory,
    packageManager: undefined,
    runScript: undefined,
    scripts: [],
    frameworks: [],
    server: undefined,
    flows: [],
    siteRoutes: [],
    scaffoldFiles: { product: "missing", design: "missing" },
    seedCandidates: [],
    envExample: undefined,
  });
  expect(setupPrompt(facts)).toContain("none found");
});

test("lockfile, relevant scripts (redacted, truncated) and framework hints", async () => {
  const directory = await temporary();
  await writeFile(join(directory, "pnpm-lock.yaml"), "");
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      scripts: {
        dev: "next dev -p 4000",
        lint: "biome check",
        "db:seed": "tsx scripts/seed.ts --key sk-ant-abcdefghijklmnop",
        "load-fixtures": "node fixtures.js",
        build: `next build ${"x".repeat(400)}`,
        test: "vitest",
      },
      dependencies: { next: "15.0.0", "@remix-run/node": "2" },
      devDependencies: { vite: "6" },
    }),
  );
  const facts = await collectSetupFacts(directory);
  expect(facts.packageManager).toBe("pnpm");
  expect(facts.runScript).toBe("pnpm");
  expect(facts.scripts.map((script) => script.name)).toEqual([
    "dev",
    "db:seed",
    "load-fixtures",
    "build",
  ]);
  const seed = facts.scripts.find((script) => script.name === "db:seed");
  expect(seed?.command).not.toContain("sk-ant-");
  expect(seed?.command).toContain("[redacted]");
  const build = facts.scripts.find((script) => script.name === "build");
  expect(build?.command.length).toBe(200);
  expect(facts.frameworks).toEqual(["@remix-run/*", "next", "vite"]);
  expect(setupPrompt(facts)).not.toContain("sk-ant-");
});

test("scaffold server defaults, flows, site routes and pristine vs edited docs", async () => {
  const directory = await temporary();
  await initProject({ project: directory, yes: true });
  let facts = await collectSetupFacts(directory);
  expect(facts.server).toEqual({
    start: "npm start",
    build: "npm run build",
    port: 3000,
    readyUrl: "http://127.0.0.1:3000/",
    scaffoldDefaults: true,
  });
  expect(facts.scaffoldFiles).toEqual({
    product: "scaffold",
    design: "scaffold",
  });
  expect(setupPrompt(facts)).toContain(
    "These are still the scaffold defaults; replace them.",
  );

  const projectFile = join(directory, ".idiom", "project.json");
  const project = JSON.parse(await readFile(projectFile, "utf8"));
  project.server = {
    ...project.server,
    start: "bun run dev",
    port: 4100,
    readyUrl: "http://127.0.0.1:4100/",
    env: { API_TOKEN: SECRET },
  };
  await writeFile(projectFile, JSON.stringify(project));
  await writeFile(join(directory, "PRODUCT.md"), "# Product\n\nEdited.\n");
  await writeFile(
    join(directory, ".idiom", "flows", "site.json"),
    JSON.stringify({
      id: "site",
      states: [
        { id: "home", url: "/" },
        { id: "pricing", url: "/pricing" },
        { id: "todo" },
      ],
    }),
  );
  await writeFile(
    join(directory, ".idiom", "flows", "booking.json"),
    JSON.stringify({ id: "booking", states: [{ id: "a" }, { id: "b" }] }),
  );
  await writeFile(join(directory, ".idiom", "flows", "broken.json"), "{");
  facts = await collectSetupFacts(directory);
  expect(facts.server?.scaffoldDefaults).toBe(false);
  expect(facts.server?.start).toBe("bun run dev");
  expect(JSON.stringify(facts)).not.toContain(SECRET);
  expect(facts.scaffoldFiles).toEqual({
    product: "edited",
    design: "scaffold",
  });
  expect(facts.flows).toEqual([
    { id: "booking", states: 2 },
    { id: "broken", states: 0 },
    { id: "site", states: 3 },
  ]);
  expect(facts.siteRoutes).toEqual([
    { state: "home", path: "/" },
    { state: "pricing", path: "/pricing" },
    { state: "todo" },
  ]);
  const prompt = setupPrompt(facts);
  expect(prompt).not.toContain(SECRET);
  expect(prompt).toContain("`pricing` → `/pricing`");
});

test("seed candidates and example env files are listed by name, contents never read", async () => {
  const directory = await temporary();
  await mkdir(join(directory, "prisma"));
  await writeFile(join(directory, "prisma", "seed.ts"), "");
  await mkdir(join(directory, "tests", "fixtures"), { recursive: true });
  await writeFile(join(directory, ".env.example"), `API_KEY=${SECRET}\n`);
  await writeFile(join(directory, ".env"), `API_KEY=${SECRET}\n`);
  const facts = await collectSetupFacts(directory);
  expect(facts.seedCandidates).toEqual(["prisma/seed.ts", "tests/fixtures"]);
  expect(facts.envExample).toBe(".env.example");
  const prompt = setupPrompt(facts);
  expect(prompt).toContain(".env.example");
  expect(prompt).not.toContain(SECRET);
  expect(JSON.stringify(facts)).not.toContain(SECRET);
});
