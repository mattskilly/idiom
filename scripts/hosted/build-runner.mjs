import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";

await mkdir("hosted-dist", { recursive: true });
await build({
  entryPoints: ["src/hosted/worker.ts"],
  outfile: "hosted-dist/runner.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  treeShaking: true,
  external: ["playwright", "playwright/*"],
  banner: {
    js: 'import { createRequire as hostedCreateRequire } from "node:module"; const require = hostedCreateRequire(import.meta.url);',
  },
});
const hash = createHash("sha256")
  .update(await readFile("hosted-dist/runner.mjs"))
  .digest("hex");
const playwright = JSON.parse(
  await readFile("node_modules/playwright/package.json", "utf8"),
).version;
await writeFile(
  "hosted-dist/identity.json",
  `${JSON.stringify({ hash, playwright }, null, 2)}\n`,
);
console.log(`Hosted worker ${hash}; Playwright ${playwright}`);
