import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "playwright";
import { afterEach, expect, test, vi } from "vitest";
import { createArtifactWorkspace } from "../src/capture/artifacts.js";
import { createElectronLauncher } from "../src/capture/electron.js";
import { type CaptureDependencies, runCapture } from "../src/capture/run.js";
import type { BrowserSession, TupleResult } from "../src/capture/types.js";
import { flowSchema } from "../src/schemas/flow.js";
import { projectSchema } from "../src/schemas/project.js";

const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
const never = () => new Promise<never>(() => {});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
const project = projectSchema.parse({
  version: 1,
  app: { name: "Timeout", framework: "other" },
  server: {
    build: "unused",
    start: "unused",
    env: {},
    port: 3199,
    fixedPort: true,
    readyUrl: "http://127.0.0.1:3199",
  },
  capture: { maxMinutes: 1 },
  viewports: [{ name: "desktop", width: 800, height: 600 }],
  design: {},
  model: { provider: "anthropic", model: "unused" },
});
const flow = flowSchema.parse({
  id: "timeout",
  title: "Timeout",
  intent: [],
  setup: [],
  states: [
    { id: "editor", description: "Editor", url: "/", expect: {} },
    { id: "later", description: "Later", url: "/", expect: {} },
  ],
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "idiom-deadline-"));
  directories.push(path);
  return path;
}
function processDependencies(): NonNullable<CaptureDependencies["process"]> {
  return {
    spawn: ((_command: string) => {
      const child = new EventEmitter() as ChildProcess;
      Object.assign(child, {
        pid: undefined,
        exitCode: null,
        signalCode: null,
      });
      queueMicrotask(() => {
        Object.assign(child, { exitCode: 0 });
        child.emit("close", 0, null);
      });
      return child;
    }) as NonNullable<NonNullable<CaptureDependencies["process"]>["spawn"]>,
    fetch: async () => new Response("ready"),
  };
}
function dependencies(): CaptureDependencies {
  return {
    snapshotSource: async () => ({ commit: "fixture", dirty: false }),
    process: processDependencies(),
  };
}
function fakeTime() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
}
async function expire(pending: Promise<unknown>, step: string) {
  const assertion = expect(pending).rejects.toThrow(
    new RegExp(`Capture exceeded capture.maxMinutes=1:.*${step}`),
  );
  await vi.advanceTimersByTimeAsync(60000);
  await vi.advanceTimersByTimeAsync(5000);
  await assertion;
}

test("expiry before source initialization completes cannot start workspace work", async () => {
  const path = await directory();
  const entered = deferred<void>();
  const release = deferred<{ commit: string; dirty: boolean }>();
  const workspace = vi.fn(createArtifactWorkspace);
  const before = process.listenerCount("SIGINT");
  fakeTime();
  const pending = runCapture({
    projectDirectory: path,
    project,
    flow,
    dependencies: {
      ...dependencies(),
      snapshotSource: async () => {
        entered.resolve();
        return release.promise;
      },
      createArtifactWorkspace: workspace,
    },
  });
  await entered.promise;
  await expire(pending, "source snapshot");
  release.resolve({ commit: "fixture", dirty: false });
  await Promise.resolve();
  expect(workspace).not.toHaveBeenCalled();
  expect(process.listenerCount("SIGINT")).toBe(before);
  expect(vi.getTimerCount()).toBe(0);
});

test("workspace returned after expiry is cleaned without starting setup", async () => {
  const path = await directory();
  const entered = deferred<void>();
  const release =
    deferred<Awaited<ReturnType<typeof createArtifactWorkspace>>>();
  const workspace = await createArtifactWorkspace({
    projectDirectory: path,
    now: new Date(),
  });
  fakeTime();
  const pending = runCapture({
    projectDirectory: path,
    project,
    flow,
    dependencies: {
      ...dependencies(),
      createArtifactWorkspace: async () => {
        entered.resolve();
        return release.promise;
      },
    },
  });
  await entered.promise;
  await expire(pending, "workspace initialization");
  release.resolve(workspace);
  vi.useRealTimers();
  await vi.waitFor(async () => {
    await expect(access(workspace.stagingDirectory)).rejects.toThrow();
    await expect(access(workspace.dataDirectory)).rejects.toThrow();
  });
});

test.each(["tuple", "measurement", "teardown", "launch"] as const)(
  "capture deadline bounds %s and forbids later tuples/publication",
  async (stage) => {
    const path = await directory();
    const entered = deferred<void>();
    const release = deferred<BrowserSession>();
    const close = vi.fn(async () => {});
    const captures: string[] = [];
    const session: BrowserSession = {
      version: "fixture",
      close,
      capture: async (tuple) => {
        captures.push(tuple.state.id);
        tuple.onActivity?.("probe #print (observe)");
        entered.resolve();
        return never();
      },
      measure: async () => {
        entered.resolve();
        return never();
      },
    };
    const selectedFlow =
      stage === "measurement"
        ? flowSchema.parse({
            ...flow,
            toggles: {
              panel: {
                open: [{ action: "click", selector: "#panel" }],
                closed: [],
              },
            },
            toggleRegions: ["#panel"],
          })
        : flow;
    if (stage === "teardown") {
      session.capture = async () =>
        ({
          ok: true,
          status: 200,
          dom: "",
          screenshot: Buffer.from(""),
          axe: {},
          console: [],
          mismatches: [],
          startedAt: "2026-10-25T00:00:00Z",
          endedAt: "2026-10-25T00:00:00Z",
        }) satisfies TupleResult;
      session.close = vi.fn(async () => {
        entered.resolve();
        await never();
      });
    }
    fakeTime();
    let workspace:
      | Awaited<ReturnType<typeof createArtifactWorkspace>>
      | undefined;
    const pending = runCapture({
      projectDirectory: path,
      project,
      flow: selectedFlow,
      dependencies: {
        ...dependencies(),
        createArtifactWorkspace: async (options) => {
          workspace = await createArtifactWorkspace(options);
          return workspace;
        },
        browserLauncher: async () => {
          if (stage === "launch") {
            entered.resolve();
            return release.promise;
          }
          return session;
        },
      },
    });
    await entered.promise;
    await expire(
      pending,
      stage === "tuple"
        ? "state editor, viewport desktop.*probe #print"
        : stage === "measurement"
          ? "combination measurement"
          : stage === "teardown"
            ? "runtime teardown"
            : "browser launch",
    );
    expect(captures.length).toBeLessThanOrEqual(
      stage === "tuple" ? 1 : stage === "teardown" ? 2 : 0,
    );
    if (stage === "launch") {
      release.resolve(session);
      await vi.advanceTimersByTimeAsync(0);
    }
    if (stage !== "teardown") expect(close).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
    await vi.waitFor(async () => {
      if (workspace)
        await expect(access(workspace.finalDirectory)).rejects.toThrow();
    });
  },
);

test("Electron capture expires and a late application is closed exactly once", async () => {
  const path = await directory();
  const entered = deferred<void>();
  const release = deferred<ElectronApplication>();
  const close = vi.fn(async () => {});
  const electronFlow = flowSchema.parse({
    id: "desktop",
    title: "Desktop",
    intent: [],
    setup: [],
    target: {
      kind: "electron",
      launch: { executablePath: "unused", args: [] },
      window: { title: "Editor" },
    },
    states: [
      { id: "editor", description: "Editor", expect: {} },
      { id: "later", description: "Later", expect: {} },
    ],
  });
  const launcher = createElectronLauncher({
    launch: async () => {
      entered.resolve();
      return release.promise;
    },
  });
  fakeTime();
  const pending = runCapture({
    projectDirectory: path,
    project,
    flow: electronFlow,
    dependencies: { ...dependencies(), electronLauncher: launcher },
  });
  await entered.promise;
  await expire(pending, "state editor, viewport desktop.*Electron launch");
  release.resolve({ close } as unknown as ElectronApplication);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(close).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

test.each(["setup", "server build", "server readiness"])(
  "deadline covers development %s before tuple selection",
  async (stage) => {
    const path = await directory();
    const entered = deferred<void>();
    const defaults = processDependencies();
    const spawn = defaults.spawn;
    if (!spawn) throw new Error("missing spawn fixture");
    const deps: CaptureDependencies = {
      ...dependencies(),
      process: {
        ...defaults,
        spawn: ((command: string, options: Parameters<typeof spawn>[1]) => {
          if (
            (stage === "setup" && command === "setup") ||
            (stage === "server build" && command === "unused")
          ) {
            const child = new EventEmitter() as ChildProcess;
            Object.assign(child, {
              pid: undefined,
              exitCode: null,
              signalCode: null,
            });
            entered.resolve();
            return child;
          }
          return spawn(command, options);
        }) as typeof spawn,
        fetch: async () => {
          if (stage === "server readiness") {
            entered.resolve();
            return never();
          }
          return new Response("ready");
        },
      },
    };
    const selectedFlow =
      stage === "setup"
        ? flowSchema.parse({ ...flow, setup: [{ run: "setup" }] })
        : flow;
    fakeTime();
    const pending = runCapture({
      projectDirectory: path,
      project,
      flow: selectedFlow,
      dependencies: deps,
    });
    await entered.promise;
    await expire(pending, `state pending, viewport pending.*${stage}`);
  },
);

test("cancelled Electron uses a bounded force-close fallback if app.quit never settles", async () => {
  const path = await directory();
  const entered = deferred<void>();
  const close = vi.fn(never);
  const kill = vi.fn();
  const electronFlow = flowSchema.parse({
    id: "desktop",
    title: "Desktop",
    intent: [],
    setup: [],
    target: {
      kind: "electron",
      launch: { executablePath: "unused", args: [] },
      window: { title: "Editor" },
    },
    states: [{ id: "editor", description: "Editor", expect: {} }],
  });
  const launcher = createElectronLauncher({
    launch: async () =>
      ({
        close,
        process: () => ({ kill }),
        evaluate: async () => {
          entered.resolve();
          return never();
        },
      }) as unknown as ElectronApplication,
  });
  fakeTime();
  const pending = runCapture({
    projectDirectory: path,
    project,
    flow: electronFlow,
    dependencies: { ...dependencies(), electronLauncher: launcher },
  });
  await entered.promise;
  await expire(pending, "Electron launch");
  expect(close).toHaveBeenCalledTimes(1);
  expect(kill).toHaveBeenCalledWith("SIGKILL");
  expect(process.listenerCount("SIGINT")).toBe(0);
});
