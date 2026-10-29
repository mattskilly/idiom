import { execFileSync } from "node:child_process";
import { build } from "esbuild";

await build({
  entryPoints: ["scripts/measure-hosted-review.ts"],
  outfile: "hosted-dist/measure.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external: ["playwright", "playwright/*"],
  banner: {
    js: 'import {createRequire as hostedCreateRequire} from "node:module"; const require=hostedCreateRequire(import.meta.url);',
  },
});
execFileSync(process.execPath, ["hosted-dist/measure.mjs"], {
  stdio: "inherit",
});
