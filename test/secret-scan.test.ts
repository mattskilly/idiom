import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  createSecretScanner,
  scanForSecrets,
} from "../src/capture/artifacts.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
async function tree(files: Record<string, string | Buffer>) {
  const root = await mkdtemp(join(tmpdir(), "idiom-secret-scan-"));
  directories.push(root);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(root, name, ".."), { recursive: true });
    await writeFile(join(root, name), content);
  }
  return root;
}
const env = { API_TOKEN: "tok-123456", PLAIN: "tok-123456-not-secret" };
const failure = async (work: Promise<void>) =>
  work.then(
    () => undefined,
    (error: unknown) => (error as Error).message,
  );

test("identical bytes are scanned once per secret set; changed bytes are scanned again", async () => {
  const scanner = createSecretScanner();
  const page = "<html>clean</html>";
  const first = await tree({ "a/dom.html": page, "a/shot.png": "png" });
  const second = await tree({ "a/dom.html": page, "a/shot.png": "png2" });
  await scanner.scan(first, [env]);
  expect(scanner.stats).toMatchObject({ files: 2, skipped: 0 });
  await scanner.scan(second, [env]);
  // dom.html is unchanged; the screenshot changed and is searched again.
  expect(scanner.stats).toMatchObject({ files: 4, skipped: 1 });
});

test("a new secret invalidates the memo, so content scanned clean before is caught", async () => {
  const scanner = createSecretScanner();
  const page = "<html>serves server-key-987</html>";
  const directory = await tree({ "a/dom.html": page });
  await scanner.scan(directory, [env]);
  // The server's environment joins mid-run, as in a capture.
  const message = await failure(
    scanner.scan(directory, [env, { SERVER_KEY: "server-key-987" }]),
  );
  expect(message).toBe(
    "secret scan found SERVER_KEY in a/dom.html; no capture was published",
  );
});

test.each([
  ["observations.json", JSON.stringify({ text: "Bearer tok-123456" })],
  ["dom.html", "<input value='tok-123456'>"],
  [
    "screenshot.png",
    Buffer.concat([Buffer.from([0x89, 0x50]), Buffer.from("tok-123456")]),
  ],
])(
  "the memoised scan catches a secret in %s exactly as before",
  async (name, content) => {
    const directory = await tree({ [`s/v/${name}`]: content });
    const before = await failure(scanForSecrets(directory, [env]));
    const scanner = createSecretScanner();
    const after = await failure(scanner.scan(directory, [env]));
    expect(before).toBe(
      `secret scan found API_TOKEN in s/v/${name}; no capture was published`,
    );
    expect(after).toBe(before);
  },
);

test("no secrets in the environment reads nothing", async () => {
  const scanner = createSecretScanner();
  await scanner.scan(await tree({ "a.json": "{}" }), [{ PLAIN: "x" }]);
  expect(scanner.stats.files).toBe(0);
});
