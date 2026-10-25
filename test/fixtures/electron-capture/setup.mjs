import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const fixturePath = process.env.FIXTURE_PATH;
if (!fixturePath) throw new Error("FIXTURE_PATH is required");
await mkdir(dirname(fixturePath), { recursive: true });
await writeFile(
  fixturePath,
  `${JSON.stringify({ person: "Ada", availability: "Weekdays" })}\n`,
);
