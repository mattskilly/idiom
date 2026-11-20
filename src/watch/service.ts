import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { IdiomError } from "../errors.js";
import {
  idiomOnPath,
  projectSlug,
  shellQuote,
  xmlEscape,
} from "../nightly/schedule.js";

export type WatchService = {
  kind: "launchd" | "systemd";
  /** launchd label or systemd unit name. */
  name: string;
  /** Where the definition is written. */
  path: string;
  text: string;
  /** Where the watcher's output goes. */
  log: string;
};

export type ServiceRun = (file: string, args: string[]) => Promise<void>;

const exec = promisify(execFile);
const defaultRun: ServiceRun = async (file, args) => {
  await exec(file, args);
};

/** Quoted for a systemd ExecStart= or Environment= line. */
const systemdQuote = (value: string) =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;

/**
 * The login service that keeps `idiom watch` running in the project root:
 * a launchd agent on macOS, a systemd user unit on Linux. A clean stop (the
 * service manager's SIGTERM) is not restarted; a crash is, after a minute.
 */
export async function watchService(options: {
  platform: NodeJS.Platform;
  root: string;
  args: string[];
  environment?: NodeJS.ProcessEnv | undefined;
  home?: string | undefined;
}): Promise<WatchService> {
  const environment = options.environment ?? process.env;
  const { root } = options;
  const bin = (await idiomOnPath(environment)) ?? "idiom";
  // Service managers start with a bare PATH; the wrapper needs node on it.
  const path = environment.PATH || "/usr/bin:/bin";
  const home = options.home ?? environment.HOME ?? "~";
  const log = join(root, ".idiom/reports/watch.log");
  const slug = projectSlug(root);
  if (options.platform === "darwin") {
    const name = `build.idiom.watch.${slug}`;
    const plist = join(home, "Library/LaunchAgents", `${name}.plist`);
    const text = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      `<!-- Installed by idiom watch --install-service; remove with idiom watch --uninstall-service -->`,
      '<plist version="1.0">',
      "<dict>",
      "  <key>Label</key>",
      `  <string>${xmlEscape(name)}</string>`,
      "  <key>ProgramArguments</key>",
      "  <array>",
      ...[bin, "watch", ...options.args].map(
        (argument) => `    <string>${xmlEscape(argument)}</string>`,
      ),
      "  </array>",
      "  <key>WorkingDirectory</key>",
      `  <string>${xmlEscape(root)}</string>`,
      "  <key>EnvironmentVariables</key>",
      "  <dict>",
      "    <key>PATH</key>",
      `    <string>${xmlEscape(path)}</string>`,
      "  </dict>",
      "  <key>RunAtLoad</key>",
      "  <true/>",
      "  <key>KeepAlive</key>",
      "  <dict>",
      "    <key>SuccessfulExit</key>",
      "    <false/>",
      "  </dict>",
      "  <key>ThrottleInterval</key>",
      "  <integer>60</integer>",
      "  <key>ExitTimeOut</key>",
      "  <integer>60</integer>",
      "  <key>StandardOutPath</key>",
      `  <string>${xmlEscape(log)}</string>`,
      "  <key>StandardErrorPath</key>",
      `  <string>${xmlEscape(log)}</string>`,
      "</dict>",
      "</plist>",
      "",
    ].join("\n");
    return { kind: "launchd", name, path: plist, text, log };
  }
  if (options.platform === "linux") {
    const name = `idiom-watch-${slug}.service`;
    const unit = join(
      environment.XDG_CONFIG_HOME || join(home, ".config"),
      "systemd/user",
      name,
    );
    const text = [
      "# Installed by idiom watch --install-service; remove with idiom watch --uninstall-service",
      "[Unit]",
      `Description=idiom watch (${slug})`,
      "",
      "[Service]",
      "Type=simple",
      `WorkingDirectory=${systemdQuote(root)}`,
      `Environment=${systemdQuote(`PATH=${path}`)}`,
      `ExecStart=${[bin, "watch", ...options.args].map(systemdQuote).join(" ")}`,
      "Restart=on-failure",
      "RestartSec=60",
      "KillSignal=SIGTERM",
      "TimeoutStopSec=60",
      `StandardOutput=append:${log}`,
      `StandardError=append:${log}`,
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n");
    return { kind: "systemd", name, path: unit, text, log };
  }
  throw new IdiomError(
    `idiom watch --install-service supports macOS (launchd) and Linux (systemd), not ${options.platform}; run idiom watch under your own supervisor, or see the definitions with --print-service`,
  );
}

/** How to load the definition, for printing. */
export function serviceInstallCommands(
  service: WatchService,
  uid: number,
): string[] {
  return service.kind === "launchd"
    ? [`launchctl bootstrap gui/${uid} ${shellQuote(service.path)}`]
    : [
        "systemctl --user daemon-reload",
        `systemctl --user enable --now ${shellQuote(service.name)}`,
      ];
}

/** Runs and records each command; `tolerate` swallows "not loaded". */
const caller =
  (run: ServiceRun, ran: string[]) =>
  async (file: string, args: string[], tolerate = false) => {
    ran.push([file, ...args].join(" "));
    try {
      await run(file, args);
    } catch (error) {
      if (!tolerate)
        throw new IdiomError(
          `${file} ${args.join(" ")} failed: ${error instanceof Error ? error.message.trim() : String(error)}`,
        );
    }
  };

export type ServiceAction = {
  service: WatchService;
  /** The commands run, in order. */
  ran: string[];
};

/** Write the definition and start the service; replaces a loaded one. */
export async function installWatchService(
  service: WatchService,
  options: { uid: number; run?: ServiceRun | undefined },
): Promise<ServiceAction> {
  const ran: string[] = [];
  const call = caller(options.run ?? defaultRun, ran);
  await mkdir(dirname(service.log), { recursive: true });
  await mkdir(dirname(service.path), { recursive: true });
  await writeFile(service.path, service.text);
  if (service.kind === "launchd") {
    const domain = `gui/${options.uid}`;
    // Not loaded yet is fine: this only replaces an earlier install.
    await call("launchctl", ["bootout", `${domain}/${service.name}`], true);
    await call("launchctl", ["bootstrap", domain, service.path]);
  } else {
    await call("systemctl", ["--user", "daemon-reload"]);
    await call("systemctl", ["--user", "enable", "--now", service.name]);
  }
  return { service, ran };
}

/** Stop the service (SIGTERM: a clean stop) and remove its definition. */
export async function uninstallWatchService(
  service: WatchService,
  options: { uid: number; run?: ServiceRun | undefined },
): Promise<ServiceAction> {
  const ran: string[] = [];
  const call = caller(options.run ?? defaultRun, ran);
  if (service.kind === "launchd")
    await call(
      "launchctl",
      ["bootout", `gui/${options.uid}/${service.name}`],
      true,
    );
  else
    await call("systemctl", ["--user", "disable", "--now", service.name], true);
  await rm(service.path, { force: true });
  if (service.kind === "systemd")
    await call("systemctl", ["--user", "daemon-reload"], true);
  return { service, ran };
}
