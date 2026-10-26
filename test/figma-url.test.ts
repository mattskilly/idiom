import { expect, test } from "vitest";
import { figmaNodeLink, parseFigmaUrl } from "../src/design/figma/url.js";
import { designSourceSchema } from "../src/schemas/design.js";

test("parses design, file, proto and branch URLs", () => {
  expect(
    parseFigmaUrl(
      "https://www.figma.com/design/AbC123/My-file?node-id=12-34&t=x",
    ),
  ).toMatchObject({ fileKey: "AbC123", nodeId: "12:34" });
  expect(
    parseFigmaUrl("https://figma.com/file/AbC123/Old?node-id=1%3A2"),
  ).toMatchObject({ fileKey: "AbC123", nodeId: "1:2" });
  expect(
    parseFigmaUrl("https://www.figma.com/proto/AbC123/P?node-id=5-6"),
  ).toMatchObject({ fileKey: "AbC123", nodeId: "5:6" });
  expect(
    parseFigmaUrl(
      "https://www.figma.com/design/AbC123/branch/Br4nch/My-file?node-id=1-2",
    ),
  ).toMatchObject({ fileKey: "Br4nch", nodeId: "1:2" });
  expect(
    parseFigmaUrl(
      "https://www.figma.com/design/AbC123/F?node-id=1-2&version-id=998",
    ),
  ).toMatchObject({ version: "998" });
  expect(parseFigmaUrl("https://www.figma.com/design/AbC123/F")).toEqual({
    fileKey: "AbC123",
    url: "https://www.figma.com/design/AbC123/F",
  });
  for (const other of [
    "https://example.test/design/AbC123?node-id=1-2",
    "http://www.figma.com/design/AbC123/F?node-id=1-2",
    "https://www.figma.com/community/file/123",
    "design.html",
  ])
    expect(parseFigmaUrl(other)).toBeUndefined();
  expect(figmaNodeLink("AbC123", "12:34")).toBe(
    "https://www.figma.com/design/AbC123/?node-id=12-34",
  );
});

test("design sources need a node id; non-Figma URLs are untouched", () => {
  expect(
    designSourceSchema.safeParse(
      "https://www.figma.com/design/AbC123/F?node-id=1-2",
    ).success,
  ).toBe(true);
  const missing = designSourceSchema.safeParse(
    "https://www.figma.com/design/AbC123/F",
  );
  expect(missing.success).toBe(false);
  expect(missing.error?.issues.map((i) => i.message).join(" ")).toContain(
    "Copy link to selection",
  );
  expect(
    designSourceSchema.safeParse("https://www.figma.com/community/file/1")
      .success,
  ).toBe(false);
  expect(
    designSourceSchema.safeParse("https://example.test/prototype?node-id=1")
      .success,
  ).toBe(true);
  // system --learn takes a file URL without node-id through parseFigmaUrl.
  expect(parseFigmaUrl("https://www.figma.com/design/AbC123/F")?.fileKey).toBe(
    "AbC123",
  );
});
