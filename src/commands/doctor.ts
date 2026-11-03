import type { DoctorReport, DoctorStep } from "../doctor/run.js";

export { type DoctorReport, runDoctor } from "../doctor/run.js";

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
  return `${lines.join("\n")}\n`;
}
