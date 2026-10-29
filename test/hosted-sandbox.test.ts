import { expect, test, vi } from "vitest";
import {
  type CreateSandbox,
  runSandbox,
  type WorkerSandbox,
} from "../src/hosted/sandbox.js";
import { firewall } from "../src/hosted/ssrf.js";
import { HASH, ID, png, report } from "./hosted-helpers.js";

const config = {
  cap: 1_000_000,
  runtimeHash: HASH,
  snapshotId: "snap_clean",
  ipSecret: "s".repeat(32),
};
function sandbox(): WorkerSandbox {
  return {
    writeFiles: vi.fn(async () => {}),
    runCommand: vi.fn(async () => ({ exitCode: 0 })),
    read: vi.fn(async (path) =>
      path.endsWith("report.json")
        ? Buffer.from(JSON.stringify(report()))
        : png,
    ),
    stop: vi.fn(async () => ({})),
    delete: vi.fn(async () => {}),
  };
}
test("fresh nonpersistent empty-env runtime, structured fixed command and bounded output; always stop/delete", async () => {
  const worker = sandbox();
  const create = vi.fn<CreateSandbox>(async () => worker);
  const stages: string[] = [];
  const result = await runSandbox({ target: "https://example.com/" }, config, {
    id: ID,
    deadlineAt: Date.now() + 90_000,
    signal: new AbortController().signal,
    stage: (value) => stages.push(value),
    create,
    identity: async () => HASH,
  });
  expect(result.report.issues).toHaveLength(1);
  expect(create.mock.calls[0]?.[0]).toMatchObject({
    persistent: false,
    source: { type: "snapshot", snapshotId: "snap_clean" },
    env: {},
    networkPolicy: firewall(),
    resources: { vcpus: 2 },
  });
  const call = vi.mocked(worker.runCommand).mock.calls[0]?.[0];
  expect(call?.cmd).toBe("env");
  expect(call?.args).toContain("-i");
  expect(call?.args).not.toContain("https://example.com/");
  expect(stages).toEqual(["starting", "reviewing"]);
  expect(worker.stop).toHaveBeenCalledOnce();
  expect(worker.delete).toHaveBeenCalledOnce();
});
test("incompatible runtime never creates a sandbox; worker/output failures still clean up", async () => {
  const worker = sandbox();
  const create = vi.fn(async () => worker);
  const options = {
    id: ID,
    deadlineAt: Date.now() + 90_000,
    signal: new AbortController().signal,
    stage: () => {},
    create,
    identity: async () => "wrong",
  };
  await expect(
    runSandbox({ target: "https://example.com/" }, config, options),
  ).rejects.toMatchObject({ code: "unavailable" });
  expect(create).not.toHaveBeenCalled();
  vi.mocked(worker.read).mockResolvedValue(
    Buffer.from('{"assets":[{"name":"../../secret"}]}'),
  );
  await expect(
    runSandbox({ target: "https://example.com/" }, config, {
      ...options,
      identity: async () => HASH,
    }),
  ).rejects.toThrow();
  expect(worker.stop).toHaveBeenCalledOnce();
  expect(worker.delete).toHaveBeenCalledOnce();
});
test("cancellation during create cleans up a late-acquired sandbox", async () => {
  const worker = sandbox();
  let finish: (value: WorkerSandbox) => void = () => {};
  const create = vi.fn(
    () =>
      new Promise<WorkerSandbox>((resolve) => {
        finish = resolve;
      }),
  );
  const controller = new AbortController();
  let late: Promise<unknown> | undefined;
  const run = runSandbox({ target: "https://example.com/" }, config, {
    id: ID,
    deadlineAt: Date.now() + 90_000,
    signal: controller.signal,
    stage: () => {},
    create,
    identity: async () => HASH,
    lateCleanup: (promise) => {
      late = promise;
    },
  });
  await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
  controller.abort();
  await expect(run).rejects.toMatchObject({ code: "timeout" });
  finish(worker);
  await late;
  expect(worker.runCommand).not.toHaveBeenCalled();
  expect(worker.stop).toHaveBeenCalledOnce();
  expect(worker.delete).toHaveBeenCalledOnce();
});
test("absolute deadline includes startup and worker hangs, with independent teardown", async () => {
  const worker = sandbox();
  const controller = new AbortController();
  vi.mocked(worker.runCommand).mockImplementation(() => new Promise(() => {}));
  const run = runSandbox({ target: "https://example.com/" }, config, {
    id: ID,
    deadlineAt: Date.now() + 90_000,
    signal: controller.signal,
    stage: (stage) => {
      if (stage === "reviewing") queueMicrotask(() => controller.abort());
    },
    create: async () => worker,
    identity: async () => HASH,
  });
  await expect(run).rejects.toMatchObject({ code: "timeout" });
  expect(worker.stop).toHaveBeenCalledOnce();
  expect(worker.delete).toHaveBeenCalledOnce();
  await expect(
    runSandbox({ target: "https://example.com/" }, config, {
      id: ID,
      deadlineAt: 1,
      now: () => 2,
      signal: new AbortController().signal,
      stage: () => {},
      create: async () => worker,
      identity: async () => HASH,
    }),
  ).rejects.toMatchObject({ code: "timeout" });
});
test("delete is attempted even when stop fails", async () => {
  const worker = sandbox();
  vi.mocked(worker.stop).mockRejectedValue(new Error("stop unavailable"));
  await expect(
    runSandbox({ target: "https://example.com/" }, config, {
      id: ID,
      deadlineAt: Date.now() + 90_000,
      signal: new AbortController().signal,
      stage: () => {},
      create: async () => worker,
      identity: async () => HASH,
    }),
  ).rejects.toThrow();
  expect(worker.delete).toHaveBeenCalledOnce();
});
