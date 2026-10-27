import { expect, test } from "vitest";
import { classifyDocument } from "../src/document.js";

test.each([
  ["text/html", "html"],
  [" TEXT/HTML ; charset=UTF-8 ", "html"],
  ["application/xhtml+xml;charset=utf-8", "html"],
  ["image/png", "non-html"],
  ["image/svg+xml", "non-html"],
  ["application/rss+xml", "non-html"],
  ["application/atom+xml", "non-html"],
  ["application/xml", "non-html"],
  ["application/json", "non-html"],
  ["text/plain", "non-html"],
  ["text/htmlish", "non-html"],
  ["application/json; note=text/html", "non-html"],
  [undefined, "unknown"],
  ["", "unknown"],
  ["  ", "unknown"],
] as const)("classifies %j as %s", (mime, expected) => {
  expect(classifyDocument(mime)).toBe(expected);
});
