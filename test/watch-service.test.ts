import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { scheduleFor } from "../src/nightly/schedule.js";
import {
  installWatchService,
  serviceInstallCommands,
  uninstallWatchService,
  watchService,
} from "../src/watch/service.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporary() {
  const directory = await mkdtemp(join(tmpdir(), "idiom-watch-service-"));
  directories.push(directory);
  return directory;
}

// No idiom on this PATH: the definition falls back to the bare command.
const environment = { PATH: "/opt/node/bin:/usr/bin" };

test("the launchd agent runs idiom watch at login, keeps it alive after a crash only, and logs to the project", async () => {
  const service = await watchService({
    platform: "darwin",
    root: `/work/Say "it" & co's app`,
    args: ["--tracker", "autobuild", "--poll", "30000ms"],
    environment,
    home: "/Users/me",
  });
  expect(service.kind).toBe("launchd");
  expect(service.name).toBe("build.idiom.watch.say-it-co-s-app");
  expect(service.path).toBe(
    "/Users/me/Library/LaunchAgents/build.idiom.watch.say-it-co-s-app.plist",
  );
  expect(service.log).toBe(
    `/work/Say "it" & co's app/.idiom/reports/watch.log`,
  );
  for (const line of [
    "    <string>idiom</string>\n    <string>watch</string>\n    <string>--tracker</string>\n    <string>autobuild</string>\n    <string>--poll</string>\n    <string>30000ms</string>\n  </array>",
    "  <string>/work/Say &quot;it&quot; &amp; co's app</string>",
    "    <key>PATH</key>\n    <string>/opt/node/bin:/usr/bin</string>",
    "  <key>RunAtLoad</key>\n  <true/>",
    "  <key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>\n  </dict>",
    "  <key>ThrottleInterval</key>\n  <integer>60</integer>",
    "  <key>ExitTimeOut</key>\n  <integer>60</integer>",
    "  <key>StandardOutPath</key>\n  <string>/work/Say &quot;it&quot; &amp; co's app/.idiom/reports/watch.log</string>",
  ])
    expect(service.text).toContain(line);
  expect(serviceInstallCommands(service, 501)).toEqual([
    "launchctl bootstrap gui/501 '/Users/me/Library/LaunchAgents/build.idiom.watch.say-it-co-s-app.plist'",
  ]);
});

test("the systemd user unit restarts on failure only and stops with SIGTERM", async () => {
  const service = await watchService({
    platform: "linux",
    root: `/work/my "app"`,
    args: ["--severity", "blocker"],
    environment,
    home: "/home/me",
  });
  expect(service).toMatchObject({
    kind: "systemd",
    name: "idiom-watch-my-app.service",
    path: "/home/me/.config/systemd/user/idiom-watch-my-app.service",
  });
  for (const line of [
    "Type=simple",
    'WorkingDirectory="/work/my \\"app\\""',
    'Environment="PATH=/opt/node/bin:/usr/bin"',
    'ExecStart="idiom" "watch" "--severity" "blocker"',
    "Restart=on-failure",
    "RestartSec=60",
    "KillSignal=SIGTERM",
    "TimeoutStopSec=60",
    `StandardOutput=append:/work/my "app"/.idiom/reports/watch.log`,
    "WantedBy=default.target",
  ])
    expect(service.text.split("\n")).toContain(line);
});

test("an unsupported platform names the alternatives", async () => {
  await expect(
    watchService({ platform: "win32", root: "/x", args: [], environment }),
  ).rejects.toThrow(/--print-service.*|own supervisor/);
});

test("install writes the agent and bootstraps it; uninstall boots it out and removes it, tolerating not loaded", async () => {
  const home = await temporary();
  const root = await temporary();
  const calls: string[][] = [];
  const service = await watchService({
    platform: "darwin",
    root,
    args: [],
    environment,
    home,
  });
  const installed = await installWatchService(service, {
    uid: 501,
    run: async (file, args) => {
      calls.push([file, ...args]);
      if (args[0] === "bootout")
        throw new Error("Boot-out failed: 3: No such process");
    },
  });
  expect(calls).toEqual([
    ["launchctl", "bootout", `gui/501/${service.name}`],
    ["launchctl", "bootstrap", "gui/501", service.path],
  ]);
  expect(installed.ran).toHaveLength(2);
  expect(await readFile(service.path, "utf8")).toBe(service.text);
  await access(join(root, ".idiom/reports"));

  calls.length = 0;
  await uninstallWatchService(service, {
    uid: 501,
    run: async (file, args) => {
      calls.push([file, ...args]);
      throw new Error("not loaded");
    },
  });
  expect(calls).toEqual([["launchctl", "bootout", `gui/501/${service.name}`]]);
  await expect(access(service.path)).rejects.toThrow();
});

test("systemd install enables the unit now; a failed bootstrap is an error; uninstall disables then reloads", async () => {
  const home = await temporary();
  const root = await temporary();
  const service = await watchService({
    platform: "linux",
    root,
    args: [],
    environment,
    home,
  });
  const calls: string[][] = [];
  await installWatchService(service, {
    uid: 1000,
    run: async (file, args) => {
      calls.push([file, ...args]);
    },
  });
  expect(calls).toEqual([
    ["systemctl", "--user", "daemon-reload"],
    ["systemctl", "--user", "enable", "--now", service.name],
  ]);
  await expect(
    installWatchService(service, {
      uid: 1000,
      run: async (_file, args) => {
        if (args.includes("enable")) throw new Error("Unit failed");
      },
    }),
  ).rejects.toThrow(/systemctl --user enable --now .* failed: Unit failed/);
  calls.length = 0;
  await uninstallWatchService(service, {
    uid: 1000,
    run: async (file, args) => {
      calls.push([file, ...args]);
    },
  });
  expect(calls).toEqual([
    ["systemctl", "--user", "disable", "--now", service.name],
    ["systemctl", "--user", "daemon-reload"],
  ]);
  await expect(access(service.path)).rejects.toThrow();
});

test("the nightly schedule is unchanged by the shared helpers", async () => {
  const root = "/work/Say it's app";
  const cron = await scheduleFor({ kind: "cron", root, environment });
  expect(cron.text).toBe(
    "17 3 * * * cd '/work/Say it'\\''s app' && PATH='/opt/node/bin:/usr/bin' idiom nightly >> .idiom/reports/nightly.log 2>&1",
  );
  const launchd = await scheduleFor({
    kind: "launchd",
    root,
    environment,
    home: "/Users/me",
  });
  expect(launchd.path).toBe(
    "/Users/me/Library/LaunchAgents/build.idiom.nightly.say-it-s-app.plist",
  );
  expect(launchd.text).toContain(
    "  <key>Label</key>\n  <string>build.idiom.nightly.say-it-s-app</string>",
  );
  expect(launchd.install).toBe(
    "launchctl bootstrap gui/$(id -u) '/Users/me/Library/LaunchAgents/build.idiom.nightly.say-it-s-app.plist'",
  );
});
