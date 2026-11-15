import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { loadCaptureRun } from "../src/review/artifacts.js";
import { storedRun } from "./stored-run-support.js";

test("metadata from and combination load onto tuples; malformed from is rejected", async () => {
  const project = await mkdtemp(join(tmpdir(), "idiom-state-jump-"));
  await storedRun(project, "run", "abc123", [
    { state: "editor", html: "before.html" },
    {
      state: "drawer",
      html: "before.html",
      declares: { from: ["editor", "home"] },
    },
    {
      state: "editor.panel-wide",
      html: "before.html",
      metadata: {
        combination: {
          base: "editor",
          label: "panel=wide",
          options: { panel: "wide" },
          equivalent: [],
        },
      },
    },
  ]);
  const runDirectory = join(project, ".idiom", "reports", "run");
  const { tuples } = await loadCaptureRun({
    runDirectory,
    expectedFlow: "studio-lab",
  });
  const byState = new Map(tuples.map((entry) => [entry.state, entry]));
  expect(byState.get("editor")).not.toHaveProperty("from");
  expect(byState.get("drawer")?.from).toBe("editor");
  expect(byState.get("editor.panel-wide")).toMatchObject({
    combination: "panel=wide",
    combinationBase: "editor",
    combinationOptions: { panel: "wide" },
  });
  const metadataPath = join(runDirectory, "drawer", "desktop", "metadata.json");
  const record = JSON.parse(await readFile(metadataPath, "utf8"));
  await writeFile(
    metadataPath,
    JSON.stringify({ ...record, state: { ...record.state, from: "editor" } }),
  );
  await expect(
    loadCaptureRun({ runDirectory, expectedFlow: "studio-lab" }),
  ).rejects.toThrow(/invalid metadata/);
}, 30_000);
