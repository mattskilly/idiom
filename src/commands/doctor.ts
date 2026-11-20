import { leftoverServerMessage } from "../capture/server-registry.js";
import type { DoctorReport, DoctorStep } from "../doctor/run.js";
import { renderSurfaces } from "../doctor/surfaces.js";

export { type DoctorReport, runDoctor } from "../doctor/run.js";
export {
  inspectSurfaces,
  renderSurfaces,
  type SurfaceEntry,
  type SurfacesReport,
} from "../doctor/surfaces.js";

const MARK: Record<DoctorStep["status"], string> = {
  pass: "✓",
  fail: "✗",
  warn: "!",
  skip: "–",
};

export function renderDoctorReport(
  report: DoctorReport,
  options: {
    /** Say so when no condition is open; off where doctor is embedded. */
    noneOpenLine?: boolean;
  } = {},
): string {
  const subject = report.flow ?? "project";
  const width = Math.max(...report.steps.map((step) => step.id.length));
  const open = report.conditions ?? [];
  const lines = [
    `idiom doctor ${subject}: ${report.failure === undefined ? (open.length === 0 ? "ok" : `ok; ${open.length} open condition(s)`) : report.failure.message}`,
  ];
  for (const leftover of report.leftovers ?? [])
    lines.push(leftoverServerMessage(leftover));
  for (const step of report.steps) {
    lines.push(
      `${MARK[step.status]}  ${step.id.padEnd(width)}  ${`${step.ms}ms`.padStart(7)}  ${step.detail ?? ""}`.trimEnd(),
    );
    if (
      step.hint !== undefined &&
      (step.status === "fail" || step.status === "warn")
    )
      lines.push(`   ${"".padEnd(width)}  fix: ${step.hint}`);
  }
  if (open.length > 0 || options.noneOpenLine !== false)
    lines.push(
      "",
      ...(open.length === 0
        ? ["No open conditions from unattended runs."]
        : [
            `Open conditions (${open.length}):`,
            ...open.flatMap((condition) => [
              `  ${condition.line}`,
              `    ${condition.ticket === undefined ? "" : `ticket ${condition.ticket}; `}seen ${condition.runs}× since ${condition.firstSeen.slice(0, 10)}, last ${condition.lastSeen.slice(0, 10)} by ${condition.mode}`,
            ]),
          ]),
    );
  if (report.surfaces !== undefined)
    lines.push("", ...renderSurfaces(report.surfaces));
  return `${lines.join("\n")}\n`;
}
