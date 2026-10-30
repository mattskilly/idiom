import { expect, test, vi } from "vitest";
import { renderHostedReport } from "../src/hosted/render.js";
import { runWorker } from "../src/hosted/runner.js";
import { runQuick } from "../src/quick/run.js";
import { loadCaptureRun } from "../src/review/artifacts.js";
import { collapseIssues } from "../src/review/issues.js";
import { HASH, ID } from "./hosted-helpers.js";

vi.mock("../src/quick/run.js", () => ({ runQuick: vi.fn() }));
vi.mock("../src/review/artifacts.js", () => ({ loadCaptureRun: vi.fn() }));

test("hosted runner and HTML retain the severity-ranked quick Top-5 prefix", async () => {
  const issues = collapseIssues(
    Array.from({ length: 8 }, (_, i) => ({
      id: `group-${i}`,
      severity: i === 7 ? ("major" as const) : ("minor" as const),
      category: i < 6 ? "dead-control" : "target-size",
      rule: `rule-${i}`,
      selector: `#item-${i}`,
      coordinates: ["page-1/desktop/light"],
      members: [`finding-${i}`],
    })),
    new Set(),
  );
  expect(issues[0]?.id).toBe("group-7");
  vi.mocked(runQuick).mockImplementation(
    async (options) =>
      ({
        runDirectory: options.out,
        issues,
        findings: [],
        groups: [],
        findingCount: 8,
        interaction: { status: "off" },
      }) as unknown as Awaited<ReturnType<typeof runQuick>>,
  );
  vi.mocked(loadCaptureRun).mockResolvedValue({
    commit: "abc",
    tuples: [
      {
        state: "page-1",
        viewport: "desktop",
        colorScheme: "light",
        width: 1440,
        height: 900,
        mismatches: [],
      },
    ],
  } as unknown as Awaited<ReturnType<typeof loadCaptureRun>>);
  const { report } = await runWorker(
    { target: "https://example.com/" },
    {
      runtimeHash: HASH,
      signal: new AbortController().signal,
      resolver: async () => [{ address: "8.8.8.8", family: 4 }],
    },
  );
  expect(report.issues.map((i) => [i.title, i.severity])).toEqual(
    issues.slice(0, 5).map((i) => [i.rules.join(", "), i.severity]),
  );
  const html = renderHostedReport(
    ID,
    report,
    Date.parse("2026-11-05T00:00:00Z"),
  );
  const positions = report.issues.map((i) => html.indexOf(i.title));
  expect(positions.every((p) => p >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
});
