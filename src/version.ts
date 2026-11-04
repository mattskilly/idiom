import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { INTERFACE_VERSION } from "./interface/version.js";

type PackageMetadata = { version?: unknown };

export const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function readPackageVersion(): string {
  const packageFile = new URL("../package.json", import.meta.url);
  const metadata = JSON.parse(
    readFileSync(packageFile, "utf8"),
  ) as PackageMetadata;
  if (typeof metadata.version !== "string" || !SEMVER.test(metadata.version)) {
    throw new Error(`Invalid semantic version in ${packageFile.pathname}`);
  }
  return metadata.version;
}

export const IDIOM_VERSION = readPackageVersion();

// Replaced with a literal by tsup; direct source imports use a development sentinel.
declare const __IDIOM_BUILD_COMMIT__: string;
export const IDIOM_BUILD_COMMIT =
  typeof __IDIOM_BUILD_COMMIT__ === "string"
    ? __IDIOM_BUILD_COMMIT__
    : "unknown";
export const IDIOM_VERSION_DISPLAY = `${IDIOM_VERSION} (${IDIOM_BUILD_COMMIT.slice(0, 7)}) · interface ${INTERFACE_VERSION}`;

/** The installed package root; from `dist/cli.js` and `src/version.ts` alike. */
export const IDIOM_PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
