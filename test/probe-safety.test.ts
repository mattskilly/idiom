import { expect, test } from "vitest";
import {
  createProbeSafetyLedger,
  probeRequestAllowed,
  recordProbeRequest,
} from "../src/capture/probe.js";
import { DESTRUCTIVE_ACTION_PATTERN } from "../src/copy-policy.js";

const request = (method: string, url = "https://example.com/x") => ({
  method: () => method,
  url: () => url,
});

test("the third-party policy drops the dev-server request exemption", () => {
  const hot = request("POST", "https://example.com/x/__nextjs_original");
  expect(probeRequestAllowed(hot)).toBe(true);
  expect(probeRequestAllowed(hot, "app")).toBe(true);
  expect(probeRequestAllowed(hot, "third-party")).toBe(false);
  expect(
    probeRequestAllowed(
      request("POST", "https://example.com/_next/static/hot-update.json"),
      "third-party",
    ),
  ).toBe(false);
  for (const method of ["GET", "HEAD", "OPTIONS"]) {
    expect(probeRequestAllowed(request(method), "app")).toBe(true);
    expect(probeRequestAllowed(request(method), "third-party")).toBe(true);
  }
  for (const method of ["POST", "PUT", "PATCH", "DELETE"])
    expect(probeRequestAllowed(request(method), "third-party")).toBe(false);
});

test("the safety ledger counts each request once per method", () => {
  const ledger = createProbeSafetyLedger([
    "https://example.com",
    "https://example.com",
  ]);
  expect(ledger.origins).toEqual(["https://example.com"]);
  const get = request("GET");
  recordProbeRequest(ledger, get, true);
  // Page and context routes both see the same request object.
  recordProbeRequest(ledger, get, true);
  recordProbeRequest(ledger, request("GET"), true);
  recordProbeRequest(ledger, request("post"), false);
  recordProbeRequest(ledger, request("DELETE"), false);
  expect(ledger.requests).toEqual({
    sent: { GET: 2 },
    blocked: { POST: 1, DELETE: 1 },
  });
});

test("the destructive lexicon covers the names quick review never clicks", () => {
  for (const name of [
    "Delete account",
    "Remove item",
    "Sign out",
    "Log out",
    "Unsubscribe",
    "Pay now",
    "Purchase",
  ])
    expect(DESTRUCTIVE_ACTION_PATTERN.test(name)).toBe(true);
  for (const name of ["Display", "Remover-free", "Payment history", "Signup"])
    expect(DESTRUCTIVE_ACTION_PATTERN.test(name)).toBe(false);
});
