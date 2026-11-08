// Test-only Bun bridge: production wiring has no provider dependency.
import { pathToFileURL } from "node:url";

const [providerPath, targetRepo, distRoot] = process.argv.slice(2);
if (!providerPath || !targetRepo || !distRoot)
  throw new Error(
    "Expected explicit provider, target repository and distribution paths",
  );
for (const key of Object.keys(process.env))
  if (key.startsWith("AB_")) delete process.env[key];
const { abUpgrade } = await import(pathToFileURL(providerPath).href);
const report = await abUpgrade({ targetRepo, distRoot, env: {} });
process.stdout.write(JSON.stringify(report));
