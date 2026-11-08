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

export function renderDoctorReport(report: DoctorReport): string {
  const subject = report.flow ?? "project";
  const width = Math.max(...report.steps.map((step) => step.id.length));
  const lines = [
    `idiom doctor ${subject}: ${report.failure === undefined ? "ok" : report.failure.message}`,
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
  if (report.surfaces !== undefined)
    lines.push("", ...renderSurfaces(report.surfaces));
  return `${lines.join("\n")}\n`;
}
