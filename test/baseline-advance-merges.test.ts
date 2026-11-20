import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "smol-toml";
import { expect, test } from "vitest";
import { baseCachePath, readBaseCache } from "../src/baseline/base-cache.js";
import { runWiring } from "../src/wiring/run.js";
import { baseFixture, cli, page } from "./support/base-gate-fixture.js";

/**
 * The spec's evidence: wire the Autobuild finalize step, merge three times,
 * run the wired command after each merge, and confirm a branch from the
 * latest merge gates against the advanced baseline with no base capture.
 */
test("after wiring, every merge advances the baseline and the next branch's gate finds it", async () => {
  const f = await baseFixture();
  try {
    await f.write(
      "autobuild.toml",
      'baseBranch = "main"\n\n[commands]\nsetup = "node -e 0"\n\n[verify]\nsteps = []\n\n[finalize]\nsteps = []\n',
    );
    await f.commit("autobuild");
    const report = await runWiring(
      f.directory,
      {},
      {
        select: async ({ defaults }) => ({
          ...defaults,
          selected: ["autobuild-baseline"],
        }),
        confirm: async () => true,
      },
      () => {},
    );
    expect(report.mode).toBe("applied");
    const config = parse(
      await readFile(join(f.directory, "autobuild.toml"), "utf8"),
    ) as { commands: Record<string, string> };
    const wired = config.commands["idiom-baseline"];
    expect(wired).toBe("idiom baseline advance --fetch");
    await f.commit("wire baseline advance");
    const argv = (wired ?? "").split(" ").slice(1);

    const cachePath = await baseCachePath(f.directory, "site");
    const merges: string[] = [];
    for (const index of [1, 2, 3]) {
      await f.git("checkout", "--quiet", "-b", `feature-${index}`);
      await f.write("app/r0/page.tsx", page(`<h1>Home ${index}</h1>`));
      await f.commit(`feature ${index}: home copy`);
      await f.git("checkout", "--quiet", "main");
      await f.git(
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
        "merge",
        "--quiet",
        "--no-ff",
        "-m",
        `Merge feature-${index}`,
        `feature-${index}`,
      );
      const merge = await f.git("rev-parse", "HEAD");
      merges.push(merge);
      const last = index === 3;
      const advanced = await cli(f.directory, [
        ...argv,
        ...(last ? ["--commit-file"] : []),
        "--json",
      ]);
      expect(advanced.status, advanced.err).toBe(0);
      const result = JSON.parse(advanced.out);
      expect(result.commit).toBe(merge);
      // No remote in the fixture: --fetch says why it fetched nothing.
      expect(result.fetched).toContain("not fetched");
      expect(result.flows[0]).toMatchObject({
        flow: "site",
        status: "advanced",
        failedTuples: [],
      });
      const commits = (await readBaseCache(cachePath, "site")).map(
        (record) => record.commit,
      );
      expect(commits).toContain(merge);
      console.log(
        `merge ${index} ${merge.slice(0, 12)}: base cache records ${commits.map((commit) => commit.slice(0, 12)).join(", ")}`,
      );
      if (last) {
        const file = JSON.parse(
          await readFile(
            join(f.directory, ".idiom/baselines/site.json"),
            "utf8",
          ),
        );
        expect(file.records[0].commit).toBe(merge);
        // The GitHub job commits this; the gate below relies on the cache.
        await rm(join(f.directory, ".idiom/baselines/site.json"));
      }
    }
    expect(
      (await readBaseCache(cachePath, "site")).map((record) => record.commit),
    ).toEqual([...merges].reverse());

    // A branch from the latest merge gates against it with no capture.
    await f.git("checkout", "--quiet", "-b", "feature-4");
    await f.write(
      "app/r1/page.tsx",
      page('<h1>Detail</h1><p id="a">A</p><p id="b">B</p><p>More</p>'),
    );
    await f.commit("feature 4: detail copy");
    const gate = await cli(f.directory, [
      "check",
      "--gate",
      "--fail-on",
      "major",
      "--json",
    ]);
    expect(gate.status, gate.err).toBe(0);
    const output = JSON.parse(gate.out);
    expect(output.gate.comparisons.site.mode).toBe("base-cache");
    expect(output.gate.comparisons.site.baseCaptureMs).toBeUndefined();
    expect(output.checks[0].summary.baseline).toMatchObject({
      source: "base-cache",
      base: merges[2],
    });
  } finally {
    await f.cleanup();
  }
}, 240_000);
