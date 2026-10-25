import { appendFileSync } from "node:fs";

const [label, delay = "0"] = process.argv.slice(2);
if (process.env.MARKER !== undefined) {
  await new Promise((accept) => setTimeout(accept, Number(delay)));
  appendFileSync(
    process.env.MARKER,
    `${label}:${process.env.DATA_VALUE ?? ""}\n`,
  );
}
process.stdout.write(`stdout:${label}\n`);
if (process.env.FAIL_STEP === label) {
  process.stderr.write(
    `failed ${label}: ${process.env.TEST_SECRET_KEY ?? ""}\n`,
  );
  process.exitCode = 7;
}
