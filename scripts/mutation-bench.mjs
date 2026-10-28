#!/usr/bin/env node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "tsup";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
let output = join(root, "docs/field-test/recall.json");
const caseIds = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--out" && args[i + 1]) output = resolve(args[++i]);
  else if (args[i] === "--case" && args[i + 1]) caseIds.push(args[++i]);
  else
    throw new Error(
      `Unknown argument: ${args[i]}; use --out PATH and/or --case 'operator::page'`,
    );
}
if (caseIds.length && output === join(root, "docs/field-test/recall.json"))
  throw new Error(
    "Filtered runs require --out and cannot overwrite the full report",
  );
const temporary = await mkdtemp(join(root, "node_modules/.mutation-bench-"));
try {
  await build({
    entry: [join(root, "test/mutation-support.ts")],
    outDir: temporary,
    format: ["esm"],
    platform: "node",
    target: "node20",
    bundle: true,
    splitting: false,
    sourcemap: false,
    dts: false,
    config: false,
    silent: true,
    external: ["playwright", "@axe-core/playwright", "pngjs"],
    esbuildOptions(options) {
      options.banner = {
        js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
      };
    },
  });
  const { runMutationBench } = await import(
    pathToFileURL(join(temporary, "mutation-support.js")).href
  );
  let report;
  try {
    report = await runMutationBench({
      root,
      ...(caseIds.length ? { caseIds } : {}),
      onCase: (id) => process.stderr.write(`${id}\n`),
    });
  } catch (error) {
    report = {
      version: 1,
      scope: caseIds.length ? "selection" : "full-catalog",
      status: "incomplete",
      setupErrors: [String(error)],
      perRule: {},
      overall: {
        attempted: 0,
        caught: 0,
        missed: 0,
        errors: 1,
        recall: null,
        medianRank: null,
      },
      cases: [],
      skipped: [],
      misses: [],
    };
  }
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.table([
    ...Object.entries(report.perRule).map(([rule, measurement]) => ({
      rule,
      ...measurement,
    })),
    { rule: "overall", ...report.overall },
  ]);
  for (const miss of report.misses)
    console.log(
      `MISS ${miss.operator} ${miss.page}: ${miss.rule}; ${miss.diagnostic}`,
    );
  for (const error of report.cases.filter((item) => item.status === "error"))
    console.error(`ERROR ${error.id}: ${error.diagnostic}`);
  for (const error of [
    ...(report.setupErrors ?? []),
    ...(report.catalogErrors ?? []),
  ])
    console.error(`ERROR ${error}`);
  console.log(`${report.status}: ${output}`);
  if (report.status !== "complete") process.exitCode = 1;
} finally {
  await rm(temporary, { recursive: true, force: true });
}
