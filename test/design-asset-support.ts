/** Design-asset fixtures shared by the design-asset and MCP output suites. */
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { briefDecideCommand, recordBriefInput } from "../src/commands/brief.js";
import { studioProject } from "./stored-run-support.js";
import { artifactV2, png } from "./verify-support.js";

export const briefFixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/brief/pinned-group-brief.json", import.meta.url),
    "utf8",
  ),
);

export const tileHeight = {
  flow: "studio-lab",
  state: "editor",
  selector: ".drawer-item",
  height: 56,
};

export function withAssertions(assertions: unknown[], extra: object = {}) {
  return {
    ...briefFixture,
    slug: "pinned-group",
    acceptanceCriteria: briefFixture.acceptanceCriteria.map(
      (criterion: { kind: string }, index: number) =>
        index === 0 ? { ...criterion, assertions } : criterion,
    ),
    ...extra,
  };
}

/** The studio-lab project with the pinned-group brief recorded and decided. */
export async function decidedBriefProject(
  directories: string[],
  assertions: unknown[] = [tileHeight],
  option = "corner-pin",
) {
  const { project } = await studioProject(directories, ["editor", "empty"]);
  await recordBriefInput({ project, input: withAssertions(assertions) });
  await briefDecideCommand({ project, slug: "pinned-group", option });
  return project;
}

/** A stored capture of studio-lab, laid out the way capture writes it. */
export async function storedCapture(
  project: string,
  states: string[],
  runId = "2026-11-01T10-00-00-000Z",
): Promise<string> {
  const run = join(project, ".idiom", "reports", runId);
  for (const [index, state] of states.entries()) {
    const tuple = join(run, state, "desktop");
    await mkdir(tuple, { recursive: true });
    await Promise.all([
      writeFile(join(tuple, "screenshot.png"), png(2, 2, 10 + index)),
      writeFile(join(tuple, "dom.html"), "<html></html>"),
      writeFile(join(tuple, "console.jsonl"), ""),
      writeFile(join(tuple, "axe.json"), JSON.stringify({ violations: [] })),
      writeFile(
        join(tuple, "observations.json"),
        JSON.stringify(artifactV2(state)),
      ),
      writeFile(
        join(tuple, "metadata.json"),
        JSON.stringify({
          source: { commit: "0123456789abcdef0123", dirty: false },
          flow: { id: "studio-lab", title: "Studio" },
          state: { id: state, description: state },
          viewport: {
            name: "desktop",
            width: 1440,
            height: 900,
            deviceScaleFactor: 2,
          },
          url: {
            kind: "literal",
            origin: "http://127.0.0.1:3100",
            url: `http://127.0.0.1:3100/lab/${state}`,
          },
          timestamps: {
            startedAt: "2026-11-01T10:00:00.000Z",
            endedAt: "2026-11-01T10:00:01.000Z",
          },
          status: 200,
          expectations: { passed: true, mismatches: [] },
          failure: null,
        }),
      ),
    ]);
  }
  await writeFile(
    join(run, "baseline.md"),
    `# Capture\n\nFlow \`studio-lab\`: ${states.length} passed, 0 failed, ${states.length} total.\n`,
  );
  return run;
}

/** An `ab` that logs its argv, cwd and the exported files, then answers JSON. */
export async function fakeAbCli(
  directories: string[],
): Promise<{ bin: string; log: string }> {
  const bin = await mkdtemp(join(tmpdir(), "idiom-fake-ab-"));
  directories.push(bin);
  const log = join(bin, "log.txt");
  await writeFile(
    join(bin, "ab"),
    [
      "#!/bin/sh",
      'if [ -n "$AB_FAIL" ]; then echo "ticket file-9 not found" >&2; exit 3; fi',
      'printf "cwd %s\\n" "$(pwd -P)" >> "$AB_LOG"',
      'printf "argv %s\\n" "$*" >> "$AB_LOG"',
      'ls "$5" "$5/screenshots" >> "$AB_LOG"',
      "echo '{\"attached\":true}'",
      "",
    ].join("\n"),
  );
  await chmod(join(bin, "ab"), 0o755);
  return { bin, log };
}
