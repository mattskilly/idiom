import { execFile } from "node:child_process";
import { access, chmod, copyFile, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { changedFixture } from "./changed-support.js";
import { fixtureCommand } from "./support/fixture-server.js";

const exec = promisify(execFile);
const fixtures = join(import.meta.dirname, "fixtures/decision-escalation");
const cli = resolve(import.meta.dirname, "../build/cli.js");

test("real gate -> escalation -> explicit guidance/commit -> revalidation -> no repeat question", async () => {
  const f = await changedFixture({}, 1);
  try {
    const html = (radius: number) =>
      `<!doctype html><html lang="en"><head><title>Decision fixture</title><style>h1{border-radius:${radius}px;background:#eee;width:200px;padding:24px}</style></head><body><main><h1 data-idiom-name="title">Hello</h1></main></body></html>`;
    await f.write("designs/a.html", html(8));
    await f.write("designs/b.html", html(12));
    const project = JSON.parse(
      await readFile(join(f.directory, ".idiom/project.json"), "utf8"),
    );
    project.server.start = fixtureCommand(join(fixtures, "server.mjs"));
    project.checks.loadingStuck = { enabled: false };
    await f.write(".idiom/project.json", JSON.stringify(project));
    const flow = JSON.parse(
      await readFile(join(f.directory, ".idiom/flows/site.json"), "utf8"),
    );
    flow.states[0].design = [
      { name: "app", source: "designs/a.html" },
      { name: "other", source: "designs/b.html" },
    ];
    await f.write(".idiom/flows/site.json", JSON.stringify(flow));
    await f.write(
      ".gitignore",
      `${await readFile(join(f.directory, ".gitignore"), "utf8")}\n.ab/\n`,
    );
    await f.commit();
    await f.write(
      "app/r0/page.tsx",
      "export default function Page() { return <main>Changed UI</main>; }\n",
    );
    await f.write(
      ".ab/context.json",
      JSON.stringify({ build: "fixture-build", phase: "verify:idiom-check" }),
    );
    await mkdir(join(f.directory, ".ab/bin"), { recursive: true });
    await copyFile(
      join(fixtures, "fake-ab.mjs"),
      join(f.directory, ".ab/bin/ab"),
    );
    await chmod(join(f.directory, ".ab/bin/ab"), 0o755);
    const protocol = () =>
      exec(process.execPath, [join(fixtures, "protocol.mjs"), cli], {
        cwd: f.directory,
        env: {
          ...process.env,
          PATH: `${join(f.directory, ".ab/bin")}:${process.env.PATH}`,
          IDIOM_UPDATE_CHECK: "0",
        },
        maxBuffer: 16 * 1024 * 1024,
      });
    const events = async () =>
      (await readFile(join(f.directory, ".ab/events.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
    await protocol();
    expect(
      await readFile(
        join(f.directory, ".ab/idiom-decisions/status.txt"),
        "utf8",
      ),
    ).toBe("4");
    expect((await events()).filter((e) => e[0] === "escalate")).toHaveLength(1);
    expect((await events()).some((e) => e[0] === "verdict")).toBe(false);
    const snapshot = JSON.parse(
      await readFile(
        join(f.directory, ".ab/idiom-decisions/questions.json"),
        "utf8",
      ),
    );
    const reason = `Intended reference; $(touch ${join(f.directory, "injected")})`;
    const answers = snapshot.questions.map(
      (q: { key: string; id: string; options: { label: string }[] }) => ({
        key: q.key,
        id: q.id,
        option: q.options.findIndex((o) => o.label === "app"),
        reason,
      }),
    );
    await f.write(
      ".ab/guidance.json",
      JSON.stringify({ escalation: "esc-1", answer: JSON.stringify(answers) }),
    );
    await f.write(
      ".ab/context.json",
      JSON.stringify({
        build: "fixture-build",
        phase: "verify:idiom-check",
        feedback: "guidance",
      }),
    );
    const original = (await f.git("rev-parse", "HEAD")).trim();
    await protocol();
    expect((await events()).filter((e) => e[0] === "verdict")).toEqual([
      ["verdict", "fail", "--report", ".ab/revalidate.md"],
    ]);
    expect((await f.git("rev-parse", "HEAD")).trim()).not.toBe(original);
    const bytes = await readFile(
      join(f.directory, ".idiom/decisions.jsonl"),
      "utf8",
    );
    expect(JSON.parse(bytes.trim().split("\n")[0] ?? "{}")).toMatchObject({
      reason,
      provenance: { build: "fixture-build", escalation: "esc-1" },
    });
    await expect(access(join(f.directory, "injected"))).rejects.toThrow();
    // A retry after append/commit must not append again or certify the old head.
    await protocol();
    expect(
      await readFile(join(f.directory, ".idiom/decisions.jsonl"), "utf8"),
    ).toBe(bytes);
    await f.write(
      ".ab/context.json",
      JSON.stringify({ build: "fixture-build", phase: "verify:idiom-check" }),
    );
    await protocol();
    expect((await events()).filter((e) => e[0] === "escalate")).toHaveLength(1);
    expect((await events()).at(-1)?.slice(0, 2)).toEqual(["verdict", "pass"]);
    expect(
      JSON.parse(
        await readFile(
          join(f.directory, ".ab/idiom-decisions/stdout.json"),
          "utf8",
        ),
      ).decisionNeeded,
    ).toEqual([]);
  } finally {
    await f.cleanup();
  }
}, 120_000);
