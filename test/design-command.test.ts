import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createProgram } from "../src/cli.js";
import { addDesignCommand } from "../src/commands/design.js";
import { initProject } from "../src/commands/init.js";

test("design add preserves authored JSON and disambiguates without writing on error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "idiom-design-command-"));
  try {
    await initProject({ project: directory, yes: true });
    const raw = {
      id: "example",
      title: "Example",
      intent: [],
      setup: [],
      states: [{ id: "home", description: "Home", url: "/", expect: {} }],
      routes: ["/about"],
    };
    const file = join(directory, ".idiom", "flows", "example.json");
    await writeFile(file, JSON.stringify(raw));
    const nested = join(directory, "designs");
    await mkdir(nested);
    const assigned = await addDesignCommand({
      cwd: nested,
      state: "home",
      source: "Screen.html",
      flow: "example",
    });
    expect(assigned.source).toBe("designs/Screen.html");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      ...raw,
      states: [{ ...raw.states[0], design: "designs/Screen.html" }],
    });
    const bytes = await readFile(file, "utf8");
    expect(
      (
        await addDesignCommand({
          cwd: nested,
          state: "home",
          source: "Screen.html",
          flow: "example",
        })
      ).changed,
    ).toBe(false);
    await expect(
      addDesignCommand({
        cwd: nested,
        state: "no-state",
        source: "Screen.html",
      }),
    ).rejects.toThrow("No authored state");
    await expect(
      addDesignCommand({
        cwd: nested,
        state: "home",
        source: "file:///secret.html",
      }),
    ).rejects.toThrow();
    await writeFile(
      join(directory, ".idiom", "flows", "other.json"),
      JSON.stringify({ ...raw, id: "other" }),
    );
    await expect(
      addDesignCommand({ cwd: nested, state: "home", source: "Screen.html" }),
    ).rejects.toThrow("ambiguous");
    expect(await readFile(file, "utf8")).toBe(bytes);
    const program = createProgram({
      cwd: directory,
      stdout: () => {},
      stderr: () => {},
    });
    program.exitOverride();
    await expect(
      program.parseAsync(["review", "example", "--design", "Screen.html"], {
        from: "user",
      }),
    ).rejects.toThrow("--design requires --page");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
