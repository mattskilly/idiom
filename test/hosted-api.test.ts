import { expect, test, vi } from "vitest";
import { type ApiDependencies, hostedApi } from "../src/hosted/api.js";
import { LIMITS } from "../src/hosted/config.js";
import { HostedError } from "../src/hosted/errors.js";
import { AdmissionLedger } from "../src/hosted/ledger.js";
import { Reports } from "../src/hosted/reports.js";
import { imageInput, parseInput } from "../src/hosted/schema.js";
import { HASH, MemoryBlob, png, report } from "./hosted-helpers.js";

function dependencies(): ApiDependencies {
  const store = new MemoryBlob();
  const now = () => Date.now();
  const secret = "s".repeat(32);
  const ledger = new AdmissionLedger(store, secret, now);
  return {
    env: {
      IDIOM_HOSTED_REVIEW: "on",
      IDIOM_HOSTED_MONTHLY_CAP_USD: "1.5",
      IDIOM_HOSTED_RUNTIME_HASH: HASH,
      IDIOM_HOSTED_SNAPSHOT_ID: "snap_test",
      IDIOM_HOSTED_IP_SECRET: secret,
      BLOB_READ_WRITE_TOKEN: "test",
      CRON_SECRET: "cron-test",
    },
    now,
    bot: vi.fn(async () => true),
    ip: () => "8.8.8.8",
    resolve: vi.fn(async () => ({
      url: new URL("https://example.com/"),
      address: "8.8.8.8",
      family: 4,
    })),
    ledger,
    reports: new Reports(store, ledger, now),
    run: vi.fn(async (_input, _config, options) => {
      options.stage("starting");
      options.stage("reviewing");
      return { report: report(), assets: new Map([["asset-0.png", png]]) };
    }),
    cleanupSandboxes: vi.fn(async () => 0),
    lateCleanup: () => {},
  };
}
function request(form = new FormData()) {
  if (!form.has("target")) form.set("target", "https://example.com/");
  return new Request("https://idiom.build/api/hosted-review", {
    method: "POST",
    headers: { origin: "https://idiom.build" },
    body: form,
  });
}
test("disabled/invalid config touches no BotID, DNS, admission or paid execution", async () => {
  const deps = dependencies();
  for (const value of [undefined, "off", "true", "ON"]) {
    deps.env.IDIOM_HOSTED_REVIEW = value;
    expect((await hostedApi(request(), "review", deps)).status).toBe(404);
  }
  deps.env.IDIOM_HOSTED_REVIEW = "on";
  deps.env.IDIOM_HOSTED_MONTHLY_CAP_USD = "NaN";
  expect((await hostedApi(request(), "review", deps)).status).toBe(503);
  expect(deps.bot).not.toHaveBeenCalled();
  expect(deps.resolve).not.toHaveBeenCalled();
  expect(deps.run).not.toHaveBeenCalled();
  expect(deps.ledger.store).toMatchObject({ objects: new Map() });
});
test("BotID and DNS failures have no admission or sandbox", async () => {
  const deps = dependencies();
  vi.mocked(deps.bot).mockResolvedValue(false);
  expect((await hostedApi(request(), "review", deps)).status).toBe(403);
  vi.mocked(deps.bot).mockResolvedValue(true);
  vi.mocked(deps.resolve).mockRejectedValue(new HostedError("blocked-url"));
  expect((await hostedApi(request(), "review", deps)).status).toBe(400);
  expect(deps.run).not.toHaveBeenCalled();
});
test("honest ordered stages, private creator token, daily fourth and monthly cap enforced before sandbox", async () => {
  const deps = dependencies();
  const response = await hostedApi(request(), "review", deps);
  const lines = (await response.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(
    lines.filter((line) => line.type === "progress").map((line) => line.stage),
  ).toEqual(["admitted", "starting", "reviewing", "publishing", "complete"]);
  const result = lines.at(-1);
  expect(result.type).toBe("result");
  expect(result.url).not.toContain(result.deleteToken);
  const view = await hostedApi(
    new Request(`https://idiom.build/api/hosted-report?id=${result.id}`, {
      headers: { "if-none-match": "old" },
    }),
    "report",
    deps,
  );
  expect(view.status).toBe(200);
  expect(view.headers.get("x-robots-tag")).toContain("noindex");
  for (let i = 0; i < 2; i++)
    await (await hostedApi(request(), "review", deps)).text();
  expect((await hostedApi(request(), "review", deps)).status).toBe(429);
  expect(deps.run).toHaveBeenCalledTimes(3);
  deps.ip = () => "1.1.1.1";
  const denied = await hostedApi(request(), "review", deps);
  expect(denied.status).toBe(503);
  expect(await denied.text()).toContain("npm install -g @mattskilly/idiom");
  expect(deps.run).toHaveBeenCalledTimes(3);
  const config = await hostedApi(
    new Request("https://idiom.build/api/hosted-config"),
    "config",
    deps,
  );
  // The form learns the cap is exhausted; the cap and spend stay private.
  expect(await config.json()).toEqual({
    enabled: true,
    available: false,
    reason: "cap-reached",
  });
});
test("config reports availability without revealing spend, and fails closed", async () => {
  const deps = dependencies();
  const config = () =>
    hostedApi(
      new Request("https://idiom.build/api/hosted-config"),
      "config",
      deps,
    ).then((response) => response.json());
  expect(await config()).toEqual({ enabled: true, available: true });
  deps.env.IDIOM_HOSTED_MONTHLY_CAP_USD = "0.1";
  expect(await config()).toEqual({
    enabled: true,
    available: false,
    reason: "cap-reached",
  });
  deps.env.IDIOM_HOSTED_MONTHLY_CAP_USD = "";
  expect(await config()).toEqual({
    enabled: true,
    available: false,
    reason: "unavailable",
  });
  deps.env.IDIOM_HOSTED_REVIEW = "off";
  expect(await config()).toEqual({ enabled: false });
});
test("failure never advertises complete; creator deletion requires origin and token; cleanup works while off", async () => {
  const deps = dependencies();
  vi.mocked(deps.run).mockRejectedValue(new HostedError("timeout"));
  const response = await hostedApi(request(), "review", deps);
  const text = await response.text();
  expect(text).toContain('"code":"timeout"');
  expect(text).not.toContain('"type":"result"');
  const deletion = new Request(
    `https://idiom.build/api/hosted-delete?id=${HASH}`,
    {
      method: "POST",
      headers: { origin: "https://attacker.com" },
      body: JSON.stringify({ token: HASH }),
    },
  );
  expect((await hostedApi(deletion, "delete", deps)).status).toBe(400);
  deps.env.IDIOM_HOSTED_REVIEW = "off";
  expect(
    (
      await hostedApi(
        new Request("https://idiom.build/api/hosted-cleanup"),
        "cleanup",
        deps,
      )
    ).status,
  ).toBe(401);
  expect(
    (
      await hostedApi(
        new Request("https://idiom.build/api/hosted-cleanup", {
          headers: { authorization: "Bearer cron-test" },
        }),
        "cleanup",
        deps,
      )
    ).status,
  ).toBe(200);
});
test("multipart exclusivity, duplicate fields, filenames, sniffing, dimensions and byte caps", async () => {
  const form = new FormData();
  form.set("target", "https://example.com/");
  form.set("reference", "https://reference.example.com/");
  form.set("image", new Blob([new Uint8Array(png)]), "../../secrets.png");
  await expect(parseInput(request(form))).rejects.toMatchObject({
    code: "invalid-input",
  });
  form.delete("reference");
  const parsed = await parseInput(request(form));
  expect(parsed.image?.extension).toBe("png");
  form.append("target", "https://other.example.com/");
  await expect(parseInput(request(form))).rejects.toThrow();
  form.delete("target");
  form.set("target", "https://example.com/");
  form.set("reference", "https://figma.com/file/x");
  form.delete("image");
  await expect(parseInput(request(form))).rejects.toThrow();
  expect(() => imageInput(Buffer.from("<svg></svg>"))).toThrow();
  expect(() => imageInput(Buffer.alloc(LIMITS.imageBytes + 1))).toThrow();
  const huge = Buffer.from(png);
  huge.writeUInt32BE(100_000, 16);
  expect(() => imageInput(huge)).toThrow();
  await expect(
    parseInput(
      new Request("https://idiom.build", {
        method: "POST",
        headers: {
          "content-type": "multipart/form-data; boundary=x",
          "content-length": String(LIMITS.envelopeBytes + 1),
        },
        body: "bad",
      }),
    ),
  ).rejects.toThrow();
});
