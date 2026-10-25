import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, writeFile } from "node:fs/promises";

await mkdir(process.env.DATA_DIR, { recursive: true });
if ((await readdir(process.env.DATA_DIR)).length)
  throw new Error("setup data was not fresh");
const marker = randomUUID();
await writeFile(`${process.env.DATA_DIR}/marker`, marker);
await appendFile(
  process.env.AUDIT_FILE,
  `${JSON.stringify({ phase: "setup", marker, data: process.env.DATA_DIR })}\n`,
);
