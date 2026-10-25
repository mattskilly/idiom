// Ad-hoc false-positive sweep: run the 0.3 signal checks over real pages.
// Usage: bun scripts/fp-sweep.ts [--fresh] [--no-probe] [--reduced-motion|--no-reduced-motion]
//   [--schemes] [--published] [--frame=<selector>] [--primary=<selector>]
//   [--band-edges] [--word-break] [--page] [--brief=<file>] [--compound]
//   <file-or-url> [...]
// --published treats each page as a published flow's page (published-budget
// runs, with image observation).
// --schemes observes light and dark together so scheme parity runs; --frame
// and --primary set checks.frame.selector and luminanceParity.primarySelectors.
// --page turns on page-content (checks.page = {}) with axe, as review --page
// does; --brief adds a brief so unsupported claims are checked.
// --compound turns on compound-control (checks.compoundControls = {}).
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import { checksConfigFrom, signalChecks } from "../src/checks/registry.js";
import { checksConfigSchema } from "../src/schemas/project.js";
import { reviewStates } from "../test/benchmark-support.js";

const ids = new Set<string>(signalChecks.map((check) => check.id));
const args = process.argv.slice(2);
const fresh = args.includes("--fresh");
// The probe is on by default, as in capture; --probe is accepted as a no-op.
const probe = !args.includes("--no-probe");
const reducedMotion = !args.includes("--no-reduced-motion");
const schemes = args.includes("--schemes");
const published = args.includes("--published");
const option = (name: string) =>
  args.flatMap((arg) =>
    arg.startsWith(`--${name}=`) ? [arg.slice(name.length + 3)] : [],
  );
const frame = option("frame")[0];
const pageReview = args.includes("--page");
const bandEdges = args.includes("--band-edges");
const wordBreak = args.includes("--word-break");
const briefPath = option("brief")[0];
const brief =
  briefPath === undefined ? undefined : await readFile(briefPath, "utf8");
const primary = option("primary");
const checks = {
  ...(frame === undefined ? {} : { frame: { selector: frame } }),
  ...(primary.length === 0
    ? {}
    : { luminanceParity: { primarySelectors: primary } }),
  ...(pageReview ? { page: {} } : {}),
  ...(bandEdges ? { bandEdges: {} } : {}),
  ...(wordBreak ? { wordBreak: {} } : {}),
  ...(args.includes("--compound") ? { compoundControls: {} } : {}),
};
const flags = new Set([
  "--fresh",
  "--probe",
  "--no-probe",
  "--reduced-motion",
  "--no-reduced-motion",
  "--schemes",
  "--page",
  "--published",
  "--band-edges",
  "--word-break",
  "--compound",
]);
const browser = await chromium.launch();
for (const target of args.filter(
  (arg) => !flags.has(arg) && !arg.startsWith("--"),
)) {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    let html: string;
    if (target.startsWith("http")) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      await page
        .goto(target, { waitUntil: "load", timeout: 45_000 })
        .catch(() => undefined);
      await page.waitForTimeout(1500);
      html = (await page.content()).replace(
        /<head>/i,
        `<head><base href="${target}">`,
      );
      await context.close();
    } else html = await readFile(target, "utf8");
    const { findings, tuples } = await reviewStates(
      browser,
      [{ state: "page", html }],
      {
        viewport,
        fresh,
        probe,
        reducedMotion,
        checks,
        ...(pageReview ? { axe: true } : {}),
        ...(brief === undefined ? {} : { brief }),
        ...(schemes ? { colorSchemes: ["light", "dark"] as const } : {}),
        ...(published ? { published: {}, images: true } : {}),
        onObservations: (observations) => {
          const motion =
            observations.version === 2 ? observations.motion : undefined;
          console.log(
            `  motion: ${motion?.status ?? "unavailable"}; preference=${reducedMotion ? "reduce" : "no-preference"}; actions=${motion?.actions.length ?? 0}; changes=${motion?.actions.reduce((sum, a) => sum + a.changes.length, 0) ?? 0}${motion?.reason ? `; ${motion.reason}` : ""}`,
          );
        },
      },
    );
    const found = findings.filter(({ candidate }) =>
      ids.has(candidate.category),
    );
    for (const tuple of tuples)
      for (const id of [
        "luminance-parity",
        "frame",
        ...(pageReview ? ["page-content"] : []),
        ...(bandEdges ? ["band-edges"] : []),
        ...(wordBreak ? ["word-break"] : []),
      ]) {
        const check = signalChecks.find((entry) => entry.id === id);
        const coverage = check?.run({
          tuple,
          tuples,
          narrowViewport: false,
          config: checksConfigFrom(checksConfigSchema.parse(checks)),
        }).coverage;
        console.log(
          `  ${id} [${tuple.colorScheme ?? "default"}]: ${coverage?.status}${coverage?.reason ? `; ${coverage.reason.slice(0, 200)}` : ""}`,
        );
      }
    console.log(`\n== ${target} @${viewport.width}: ${found.length}`);
    for (const { candidate } of found)
      console.log(
        `  [${candidate.rule}/${candidate.severity}]${candidate.fingerprintHint === undefined ? "" : ` {${candidate.fingerprintHint}}`} ${candidate.explanation.slice(0, 240)}`,
      );
  }
}
await browser.close();
