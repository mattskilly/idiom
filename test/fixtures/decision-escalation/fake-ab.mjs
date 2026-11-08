#!/usr/bin/env node
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const args = process.argv.slice(2);
await appendFile(".ab/events.jsonl", `${JSON.stringify(args)}\n`);
await mkdir(".ab/fake-store", { recursive: true });
if (args[0] === "artifact" && args[1] === "put") {
  const kind = args[2];
  await writeFile(join(".ab/fake-store", `${kind}@1`), await readFile(args[3]));
  process.stdout.write(`${kind}@1\n`);
} else if (args[0] === "artifact" && args[1] === "get") {
  process.stdout.write(await readFile(join(".ab/fake-store", args[2]), "utf8"));
} else if (args[0] === "escalate") process.stdout.write("esc-1\n");
