import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { run } from "../src/cli.js";
import { initProject } from "../src/commands/init.js";
import {
  addReference,
  listManagedReferences,
  removeReference,
} from "../src/references/run.js";
import { projectSchema } from "../src/schemas/project.js";
import { referenceMetadataSchema } from "../src/schemas/reference.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const project = projectSchema.parse({
  version: 1,
  app: { name: "references", framework: "other" },
  server: {
    build: "true",
    start: "true",
    readyUrl: "http://127.0.0.1:1",
    port: 1,
    env: {},
  },
  viewports: [
    { name: "desktop", width: 1440, height: 900 },
    { name: "mobile", width: 390, height: 844 },
  ],
  capture: {},
  design: {},
  model: { provider: "anthropic", model: "unused" },
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "idiom-references-"));
  directories.push(directory);
  await mkdir(join(directory, ".idiom", "references"), { recursive: true });
  await mkdir(join(directory, ".idiom", "anti-references"), {
    recursive: true,
  });
  return directory;
}

test("reference metadata is strict and protects names, notes, and image paths", () => {
  const valid = {
    version: 1,
    name: "editorial-density",
    note: "Use the compact type scale.",
    image: "image.png",
    mediaType: "image/png",
    sourceKind: "url",
    source: "https://example.test/design",
    capturedAt: "2026-08-16T12:00:00.000Z",
    viewport: { name: "desktop", width: 1440, height: 900 },
  };
  expect(referenceMetadataSchema.parse(valid)).toEqual(valid);
  expect(
    referenceMetadataSchema.safeParse({ ...valid, name: "../escape" }).success,
  ).toBe(false);
  expect(
    referenceMetadataSchema.safeParse({ ...valid, note: "  " }).success,
  ).toBe(false);
  expect(
    referenceMetadataSchema.safeParse({ ...valid, image: "../image.png" })
      .success,
  ).toBe(false);
});

test("local images are copied byte-for-byte offline and listed deterministically", async () => {
  const directory = await fixture();
  const firstBytes = Buffer.from([0, 1, 2, 3, 255]);
  const secondBytes = Buffer.from("webp bytes");
  await writeFile(join(directory, "first.png"), firstBytes);
  await writeFile(join(directory, "second.webp"), secondBytes);
  const capture = vi.fn(async () => {
    throw new Error("browser/network must not run for --file");
  });

  await addReference({
    projectDirectory: directory,
    project,
    cwd: directory,
    name: "zeta",
    note: "Use this density.",
    file: "first.png",
    polarity: "reference",
    dependencies: { captureUrl: capture },
  });
  await addReference({
    projectDirectory: directory,
    project,
    cwd: directory,
    name: "alpha",
    note: "Avoid this chrome.",
    file: "second.webp",
    polarity: "anti-reference",
    dependencies: { captureUrl: capture },
  });

  expect(capture).not.toHaveBeenCalled();
  expect(
    await readFile(
      join(directory, ".idiom", "references", "zeta", "image.png"),
    ),
  ).toEqual(firstBytes);
  expect(
    (await listManagedReferences(directory)).map((entry) => entry.label),
  ).toEqual(["reference:zeta", "anti-reference:alpha"]);
});

test("URL capture records exact provenance and publishes only after success", async () => {
  const directory = await fixture();
  const capture = vi.fn(async () => Buffer.from("captured png"));
  const stored = await addReference({
    projectDirectory: directory,
    project,
    cwd: directory,
    name: "gmail-register",
    note: "Match the utilitarian register.",
    url: "https://example.test/reference?mode=exact",
    viewport: "mobile",
    polarity: "reference",
    dependencies: {
      captureUrl: capture,
      now: () => new Date("2026-08-16T14:15:16.000Z"),
    },
  });

  expect(capture).toHaveBeenCalledWith({
    url: "https://example.test/reference?mode=exact",
    project,
    viewport: { name: "mobile", width: 390, height: 844 },
  });
  expect(stored.metadata).toMatchObject({
    sourceKind: "url",
    source: "https://example.test/reference?mode=exact",
    capturedAt: "2026-08-16T14:15:16.000Z",
    viewport: { name: "mobile", width: 390, height: 844 },
  });

  await expect(
    addReference({
      projectDirectory: directory,
      project,
      cwd: directory,
      name: "broken",
      note: "Never publish partial captures.",
      url: "https://example.test/failure",
      viewport: "desktop",
      polarity: "reference",
      dependencies: {
        captureUrl: async () => {
          throw new Error("navigation failed");
        },
      },
    }),
  ).rejects.toThrow("navigation failed");
  expect(await readdir(join(directory, ".idiom", "references"))).toEqual([
    "gmail-register",
  ]);
});

test("oversized URL captures fail at add time and publish no entry", async () => {
  const directory = await fixture();
  const oversizedPng = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(oversizedPng, 0);
  oversizedPng.write("IHDR", 12, "ascii");
  oversizedPng.writeUInt32BE(1440, 16);
  oversizedPng.writeUInt32BE(8_001, 20);

  await expect(
    addReference({
      projectDirectory: directory,
      project,
      cwd: directory,
      name: "too-tall",
      note: "This must fail before publication.",
      url: "https://example.test/tall",
      viewport: "desktop",
      polarity: "reference",
      dependencies: { captureUrl: async () => oversizedPng },
    }),
  ).rejects.toThrow(/model transport limits.*1440x8001px/);
  await expect(
    addReference({
      projectDirectory: directory,
      project,
      cwd: directory,
      name: "too-large",
      note: "Encoded size must also fail before publication.",
      url: "https://example.test/large",
      viewport: "desktop",
      polarity: "reference",
      dependencies: {
        captureUrl: async () => Buffer.alloc(8 * 1024 * 1024),
      },
    }),
  ).rejects.toThrow(/model transport limits.*base64 size/);
  expect(await readdir(join(directory, ".idiom", "references"))).toEqual([]);
});

function jpegBytes(width: number, height: number): Buffer {
  const app0 = Buffer.alloc(20);
  app0.writeUInt16BE(0xffe0, 0);
  app0.writeUInt16BE(18, 2);
  app0.write("JFIF", 4, "ascii");
  const sof0 = Buffer.alloc(19);
  sof0.writeUInt16BE(0xffc0, 0);
  sof0.writeUInt16BE(17, 2);
  sof0.writeUInt8(8, 4);
  sof0.writeUInt16BE(height, 5);
  sof0.writeUInt16BE(width, 7);
  sof0.writeUInt8(3, 9);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof0]);
}

function webpLossyBytes(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(30);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(22, 4);
  bytes.write("WEBP", 8, "ascii");
  bytes.write("VP8 ", 12, "ascii");
  bytes.writeUInt32LE(10, 16);
  bytes[23] = 0x9d;
  bytes[24] = 0x01;
  bytes[25] = 0x2a;
  bytes.writeUInt16LE(width, 26);
  bytes.writeUInt16LE(height, 28);
  return bytes;
}

function webpExtendedBytes(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(30);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(22, 4);
  bytes.write("WEBP", 8, "ascii");
  bytes.write("VP8X", 12, "ascii");
  bytes.writeUInt32LE(10, 16);
  bytes.writeUIntLE(width - 1, 24, 3);
  bytes.writeUIntLE(height - 1, 27, 3);
  return bytes;
}

function gifBytes(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(13);
  bytes.write("GIF89a", 0, "ascii");
  bytes.writeUInt16LE(width, 6);
  bytes.writeUInt16LE(height, 8);
  return bytes;
}

test("oversized JPEG, WebP, and GIF local references fail at add time", async () => {
  const directory = await fixture();
  const oversized = [
    {
      file: "landing-full.jpg",
      bytes: jpegBytes(1600, 11_500),
      size: "1600x11500px",
    },
    {
      file: "wide.webp",
      bytes: webpLossyBytes(8_001, 900),
      size: "8001x900px",
    },
    {
      file: "canvas.webp",
      bytes: webpExtendedBytes(900, 9_000),
      size: "900x9000px",
    },
    { file: "tall.gif", bytes: gifBytes(900, 8_001), size: "900x8001px" },
  ];
  for (const entry of oversized) {
    await writeFile(join(directory, entry.file), entry.bytes);
    await expect(
      addReference({
        projectDirectory: directory,
        project,
        cwd: directory,
        name: "saas-landing",
        note: "Avoid this stacked-section rhythm.",
        file: entry.file,
        polarity: "anti-reference",
      }),
    ).rejects.toThrow(new RegExp(`model transport limits.*${entry.size}`));
  }
  expect(await readdir(join(directory, ".idiom", "anti-references"))).toEqual(
    [],
  );

  await writeFile(join(directory, "at-limit.gif"), gifBytes(8_000, 8_000));
  await expect(
    addReference({
      projectDirectory: directory,
      project,
      cwd: directory,
      name: "at-limit",
      note: "Exactly at the transport bound stays acceptable.",
      file: "at-limit.gif",
      polarity: "anti-reference",
    }),
  ).resolves.toMatchObject({ label: "anti-reference:at-limit" });
});

test("duplicate publication and exact removal preserve siblings and polarity peers", async () => {
  const directory = await fixture();
  await writeFile(join(directory, "source.png"), "original");
  for (const polarity of ["reference", "anti-reference"] as const) {
    await addReference({
      projectDirectory: directory,
      project,
      cwd: directory,
      name: "shared-name",
      note: `${polarity} note`,
      file: "source.png",
      polarity,
    });
  }
  await writeFile(join(directory, "source.png"), "replacement");
  await expect(
    addReference({
      projectDirectory: directory,
      project,
      cwd: directory,
      name: "shared-name",
      note: "do not overwrite",
      file: "source.png",
      polarity: "reference",
    }),
  ).rejects.toThrow("already exists");
  expect(
    await readFile(
      join(directory, ".idiom", "references", "shared-name", "image.png"),
      "utf8",
    ),
  ).toBe("original");

  await removeReference({
    projectDirectory: directory,
    name: "shared-name",
    polarity: "reference",
  });
  await expect(
    access(join(directory, ".idiom", "references", "shared-name")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await expect(
    access(join(directory, ".idiom", "anti-references", "shared-name")),
  ).resolves.toBeUndefined();
});

test("remove refuses legacy directories and argument validation happens before capture", async () => {
  const directory = await fixture();
  await mkdir(join(directory, ".idiom", "references", "legacy"));
  await writeFile(
    join(directory, ".idiom", "references", "legacy", "image.png"),
    "legacy",
  );
  await expect(
    removeReference({
      projectDirectory: directory,
      name: "legacy",
      polarity: "reference",
    }),
  ).rejects.toThrow("not a removable managed reference");
  const capture = vi.fn(async () => Buffer.from("capture"));
  await expect(
    addReference({
      projectDirectory: directory,
      project,
      cwd: directory,
      name: "invalid",
      note: "note",
      url: "https://example.test",
      viewport: "unknown",
      polarity: "reference",
      dependencies: { captureUrl: capture },
    }),
  ).rejects.toThrow("unknown project viewport");
  expect(capture).not.toHaveBeenCalled();
});

test("malformed managed entries do not poison listing and remain removable", async () => {
  const directory = await fixture();
  await writeFile(join(directory, "source.png"), "source");
  await addReference({
    projectDirectory: directory,
    project,
    cwd: directory,
    name: "healthy",
    note: "Keep this entry visible.",
    file: "source.png",
    polarity: "reference",
  });
  const broken = join(directory, ".idiom", "references", "broken");
  await mkdir(broken);
  await writeFile(join(broken, "image.png"), "broken");
  await writeFile(join(broken, "reference.json"), "{ trailing, }");
  const staging = join(directory, ".idiom", "references", ".healthy-stale");
  await mkdir(staging);
  await writeFile(join(staging, "image.png"), "stale");
  await writeFile(
    join(staging, "reference.json"),
    JSON.stringify({
      version: 1,
      name: "healthy",
      note: "Interrupted staging entry.",
      image: "image.png",
      mediaType: "image/png",
      sourceKind: "file",
      source: "source.png",
    }),
  );

  await expect(listManagedReferences(directory)).resolves.toMatchObject([
    { label: "reference:healthy" },
  ]);
  await expect(
    removeReference({
      projectDirectory: directory,
      name: "broken",
      polarity: "reference",
    }),
  ).resolves.toEqual({
    label: "reference:broken",
    name: "broken",
    polarity: "reference",
    valid: false,
  });
  await expect(access(broken)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(access(staging)).resolves.toBeUndefined();
});

test("documented CLI forms add, list, remove, and reject ambiguous sources", async () => {
  const directory = await mkdtemp(join(tmpdir(), "idiom-reference-cli-"));
  directories.push(directory);
  await initProject({ project: directory, yes: true });
  await writeFile(join(directory, "sample.png"), "sample");
  const stdout: string[] = [];
  const stderr: string[] = [];

  expect(
    await run(
      [
        "node",
        "idiom",
        "reference",
        "add",
        "local-sample",
        "--file",
        "sample.png",
        "--note",
        "Use the compact density.",
        "--project",
        directory,
      ],
      {
        cwd: directory,
        stdout: (message) => stdout.push(message),
        stderr: (message) => stderr.push(message),
        reference: {
          captureUrl: async () => {
            throw new Error("must remain offline");
          },
        },
      },
    ),
  ).toBe(0);
  expect(stdout.join("")).toContain("Stored reference:local-sample");

  const urlCapture = vi.fn(async () => Buffer.from("url png"));
  expect(
    await run(
      [
        "node",
        "idiom",
        "reference",
        "add",
        "url-sample",
        "--url",
        "https://example.test/reference",
        "--viewport",
        "desktop",
        "--note",
        "Avoid this chrome.",
        "--anti",
        "--project",
        directory,
      ],
      {
        cwd: directory,
        stdout: (message) => stdout.push(message),
        stderr: (message) => stderr.push(message),
        reference: {
          captureUrl: urlCapture,
          now: () => new Date("2026-08-16T15:00:00.000Z"),
        },
      },
    ),
  ).toBe(0);
  expect(urlCapture).toHaveBeenCalledOnce();
  expect(stdout.join("")).toContain("Stored anti-reference:url-sample");

  stdout.length = 0;
  expect(
    await run(["node", "idiom", "reference", "list", "--project", directory], {
      cwd: directory,
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
    }),
  ).toBe(0);
  expect(stdout.join("")).toContain("reference:local-sample");

  expect(
    await run(
      [
        "node",
        "idiom",
        "reference",
        "add",
        "ambiguous",
        "--file",
        "sample.png",
        "--url",
        "https://example.test",
        "--viewport",
        "desktop",
        "--note",
        "Ambiguous",
        "--project",
        directory,
      ],
      {
        cwd: directory,
        stdout: (message) => stdout.push(message),
        stderr: (message) => stderr.push(message),
      },
    ),
  ).toBe(1);
  expect(stderr.join("")).toContain("exactly one of --url or --file");

  await writeFile(
    join(directory, ".idiom", "references", "local-sample", "reference.json"),
    "{ malformed, }",
  );
  stdout.length = 0;
  expect(
    await run(["node", "idiom", "reference", "list", "--project", directory], {
      cwd: directory,
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
    }),
  ).toBe(0);
  expect(stdout.join("")).toContain("anti-reference:url-sample");
  expect(stdout.join("")).not.toContain("reference:local-sample");

  expect(
    await run(
      [
        "node",
        "idiom",
        "reference",
        "remove",
        "local-sample",
        "--project",
        directory,
      ],
      {
        cwd: directory,
        stdout: (message) => stdout.push(message),
        stderr: (message) => stderr.push(message),
      },
    ),
  ).toBe(0);
  expect(stdout.join("")).toContain("Removed reference:local-sample");
  expect(
    await run(
      [
        "node",
        "idiom",
        "reference",
        "remove",
        "url-sample",
        "--anti",
        "--project",
        directory,
      ],
      {
        cwd: directory,
        stdout: (message) => stdout.push(message),
        stderr: (message) => stderr.push(message),
      },
    ),
  ).toBe(0);
  expect(stdout.join("")).toContain("Removed anti-reference:url-sample");
});
