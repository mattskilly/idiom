import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { defaultConfirmation } from "../confirmation.js";
import { applyWrites, unchanged } from "../skills/paths.js";
import { defaultSelection, planWiring, validateWiringOptions } from "./plan.js";
import type {
  SelectWiring,
  WiringDependencies,
  WiringDetection,
  WiringOptions,
  WiringPlan,
  WiringReport,
  WiringSelection,
} from "./types.js";
import { WIRING_SURFACES } from "./types.js";

export const defaultWiringSelection: SelectWiring = async ({
  proposals,
  defaults,
}) => {
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    const available = proposals.filter(
      (row) => row.disposition !== "unavailable",
    );
    stdout.write(
      "Choose wiring surfaces (selection only; nothing is written yet):\n",
    );
    for (const row of available)
      stdout.write(
        `  ${row.selected ? "[x]" : "[ ]"} ${row.surface}: ${row.reason}\n`,
      );
    stdout.write(
      "  [ ] nightly: a scheduled idiom nightly in the GitHub workflow at 03:17 UTC, filing new findings as proposals (off unless already managed or selected); a cron/launchd line is printed below the plan\n",
    );
    const answer = (
      await readline.question(
        `Comma-separated surface IDs, plus nightly if wanted (Enter keeps ${defaults.selected.join(", ")}${defaults.nightly ? ", nightly" : ""}; 'none' clears): `,
      )
    ).trim();
    if (!answer) return defaults;
    const ids =
      answer === "none" ? [] : answer.split(",").map((id) => id.trim());
    for (const id of ids)
      if (
        id !== "nightly" &&
        !(WIRING_SURFACES as readonly string[]).includes(id)
      )
        throw new Error(`Unknown wiring selection: ${id}`);
    return {
      selected: ids.filter(
        (id) => id !== "nightly",
      ) as WiringSelection["selected"],
      nightly: ids.includes("nightly"),
    };
  } finally {
    readline.close();
  }
};
export function validateHookChoice(
  detection: WiringDetection,
  options: WiringOptions,
  canSelect: boolean,
): void {
  const hooks = [
    detection.signals[".husky"]?.detected &&
      !options.skipWiring?.includes("husky"),
    detection.signals["lefthook.yml"]?.detected &&
      !options.skipWiring?.includes("lefthook"),
  ].filter(Boolean);
  if (options.gitHook && hooks.length === 2 && !canSelect)
    throw new Error(
      "Both husky and lefthook detected. Use --git-hook --skip-wiring lefthook (or husky), or choose one interactively.",
    );
  if (options.gitHook && !hooks.length)
    throw new Error(
      "--git-hook requires an existing, unskipped .husky/ or lefthook.yml. Install a hook manager first.",
    );
}
export function renderWiringPlan(plan: WiringPlan): string {
  const lines = ["Idiom wiring plan:"];
  const signals = Object.entries(plan.detection.signals)
    .filter(([, signal]) => signal.detected)
    .map(([path]) => path);
  lines.push(
    `Detected: ${signals.join(", ") || "no repository wiring signals"}.`,
    `On PATH: claude ${plan.detection.agents.claude ? "available" : "absent"}; codex ${plan.detection.agents.codex ? "available" : "absent"} (not launched).`,
  );
  for (const row of plan.proposals) {
    // Only surfaces that will be wired or were found but left are listed.
    if (row.disposition === "unavailable") continue;
    lines.push(
      `${row.selected ? "[x]" : "[ ]"} ${row.surface}: ${row.disposition} ${row.path} — ${row.reason}`,
    );
    if (row.selected && row.preview) lines.push(row.preview.trimEnd());
  }
  if (plan.schedule !== undefined)
    lines.push(
      "Or schedule idiom nightly on this machine (nothing is written): add this crontab line,",
      `  ${plan.schedule.cron}`,
      `  or on macOS print a launchd agent with: ${plan.schedule.launchd}`,
    );
  lines.push(
    "Skipped surfaces stay unchanged. Remove idiom:wiring:<name>:begin/end sections to reverse wiring (docs/commands.md#wire-agents-ci-hooks-and-autobuild).",
  );
  return `${lines.join("\n")}\n`;
}
export async function runWiring(
  root: string,
  options: WiringOptions & {
    yes?: boolean | undefined;
    application?: "allow" | "report-only" | undefined;
  },
  dependencies: WiringDependencies = {},
  write: (message: string) => void = (message) => stdout.write(message),
): Promise<WiringReport> {
  validateWiringOptions(options);
  const interactive =
    dependencies.interactive ??
    (dependencies.confirm !== undefined || stdin.isTTY === true);
  const consenting =
    interactive &&
    options.yes !== true &&
    options.application !== "report-only";
  options = {
    ...options,
    offerGate: consenting,
    offerAutobuildSkills: consenting,
  };
  dependencies = { ...dependencies, interactive: consenting };
  const select =
    dependencies.select ??
    (stdin.isTTY && !dependencies.confirm ? defaultWiringSelection : undefined);
  const canSelect = consenting && !options.dryRun && select !== undefined;
  let plan = await planWiring(root, options, dependencies);
  validateHookChoice(plan.detection, options, canSelect);
  if (canSelect && select) {
    const choices = await select({
      proposals: plan.proposals,
      defaults: defaultSelection(plan.detection, options),
    });
    if (choices.nightly && !choices.selected.includes("github"))
      throw new Error("Nightly requires GitHub wiring selection");
    if (
      options.gitHook &&
      plan.detection.signals[".husky"]?.detected &&
      plan.detection.signals["lefthook.yml"]?.detected &&
      !choices.selected.some((id) => id === "husky" || id === "lefthook")
    )
      throw new Error("--git-hook requires choosing a hook manager");
    plan = await planWiring(root, options, dependencies, choices);
  }
  const preview = renderWiringPlan(plan);
  write(preview);
  const report = (mode: WiringReport["mode"]): WiringReport => ({
    mode,
    detection: plan.detection,
    proposals: plan.proposals,
    ...(plan.schedule === undefined ? {} : { schedule: plan.schedule }),
  });
  if (options.dryRun) return report("preview");
  if (options.application === "report-only" || (!options.yes && !interactive))
    return report("available");
  const changes = plan.writes.length || plan.apply;
  if (!changes) return report("applied");
  if (
    !options.yes &&
    !(await (dependencies.confirm ?? defaultConfirmation)({
      kind: "apply-wiring",
      path: ".",
      prompt: "Apply all selected wiring shown above? [y/N] ",
      diff: preview,
    }))
  )
    return report("declined");
  try {
    await unchanged(root, plan.snapshots);
    if (plan.apply) await plan.apply(plan.writes, dependencies.apply);
    else await applyWrites(root, plan.writes, dependencies.apply);
  } catch (error) {
    throw new Error(
      `Wiring was not applied: ${(error as Error).message}. Rerun idiom init --wire to review a fresh plan.`,
    );
  }
  return report("applied");
}
export function wiringSummaryLines(report: WiringReport): string[] {
  return [
    `Wiring ${report.mode}:`,
    ...report.proposals
      .filter((row) => row.disposition !== "unavailable")
      .map(
        (row) =>
          `${row.surface}: ${row.disposition === "create" || row.disposition === "update" ? (report.mode === "applied" ? "wired" : "available (unchanged)") : row.disposition} — ${row.reason}`,
      ),
  ];
}
