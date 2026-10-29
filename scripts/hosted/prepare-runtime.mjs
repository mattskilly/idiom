// Matt-owned provisioning step. Never used during a review or deployment build.
import { readFile } from "node:fs/promises";
import { Sandbox } from "@vercel/sandbox";

const identity = JSON.parse(
  await readFile("hosted-dist/identity.json", "utf8"),
);
const sandbox = await Sandbox.create({
  image: "node:24",
  persistent: false,
  timeout: 600_000,
  resources: { vcpus: 2 },
  env: {},
  tags: { feature: "idiom-clean-runtime" },
});
let saved = false;
try {
  const base = "/vercel/sandbox/idiom";
  await sandbox.writeFiles([
    {
      path: `${base}/runner.mjs`,
      content: await readFile("hosted-dist/runner.mjs"),
    },
    {
      path: `${base}/identity.json`,
      content: Buffer.from(JSON.stringify(identity)),
    },
    {
      path: `${base}/package.json`,
      content: Buffer.from(
        JSON.stringify({
          private: true,
          type: "module",
          dependencies: { playwright: identity.playwright },
        }),
      ),
    },
  ]);
  const commands = [
    {
      cmd: "npm",
      args: [
        "install",
        "--ignore-scripts",
        "--omit=dev",
        "--no-audit",
        "--no-fund",
      ],
      cwd: base,
    },
    {
      cmd: "env",
      args: [
        `PLAYWRIGHT_BROWSERS_PATH=${base}/browsers`,
        "npx",
        "--no-install",
        "playwright",
        "install",
        "--with-deps",
        "chromium",
      ],
      cwd: base,
    },
    // Verify Chromium and scrub npm cache/logs before saving a reusable snapshot.
    {
      cmd: "node",
      args: [
        "--input-type=module",
        "-e",
        `import {chromium} from 'playwright'; const b=await chromium.launch({headless:true}); await b.close();`,
      ],
      cwd: base,
      env: { PLAYWRIGHT_BROWSERS_PATH: `${base}/browsers` },
    },
    { cmd: "npm", args: ["cache", "clean", "--force"], cwd: base },
  ];
  for (const command of commands) {
    const result = await sandbox.runCommand(command);
    if (result.exitCode !== 0)
      throw new Error(`Preparation failed: ${command.cmd}`);
  }
  await sandbox.update({ networkPolicy: "deny-all" });
  const snapshot = await sandbox.snapshot();
  saved = true;
  console.log(
    `IDIOM_HOSTED_SNAPSHOT_ID=${snapshot.snapshotId}\nIDIOM_HOSTED_RUNTIME_HASH=${identity.hash}`,
  );
} finally {
  // The only snapshot is this clean runtime. There is no uploaded target or run.
  await sandbox.delete();
  if (!saved) console.error("No runtime snapshot prepared.");
}
