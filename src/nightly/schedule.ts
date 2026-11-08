import { stat } from "node:fs/promises";
import { basename, delimiter, join } from "node:path";
import { findProjectDirectory, resolveProjectArgument } from "../project.js";

/** Single-quoted for sh. */
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const xml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

async function idiomOnPath(environment: NodeJS.ProcessEnv) {
  for (const directory of (environment.PATH ?? "").split(delimiter)) {
    if (directory === "") continue;
    const path = join(directory, "idiom");
    try {
      if ((await stat(path)).isFile()) return path;
    } catch {
      // Not in this directory.
    }
  }
  return undefined;
}

export type NightlySchedule = {
  kind: "cron" | "launchd";
  /** The crontab line, or the plist body. */
  text: string;
  /** launchd: where to save the plist. */
  path?: string | undefined;
  /** launchd: how to load it. */
  install?: string | undefined;
};

/**
 * `idiom nightly --print-schedule`: a crontab line or launchd agent that runs
 * `idiom nightly` at 03:17 in the project root. Prints; installs nothing.
 */
export async function nightlySchedule(options: {
  kind: "cron" | "launchd";
  project?: string | undefined;
  cwd?: string | undefined;
  environment?: NodeJS.ProcessEnv | undefined;
  home?: string | undefined;
}): Promise<NightlySchedule> {
  return scheduleFor({
    ...options,
    root: await findProjectDirectory(
      resolveProjectArgument(options.project, options.cwd),
    ),
  });
}

/** The schedule for a known project root; `idiom init` offers its cron line. */
export async function scheduleFor(options: {
  kind: "cron" | "launchd";
  root: string;
  environment?: NodeJS.ProcessEnv | undefined;
  home?: string | undefined;
}): Promise<NightlySchedule> {
  const { root } = options;
  const environment = options.environment ?? process.env;
  const bin = (await idiomOnPath(environment)) ?? "idiom";
  // cron and launchd start with a bare PATH; the wrapper needs node on it.
  const path = environment.PATH || "/usr/bin:/bin";
  if (options.kind === "cron")
    return {
      kind: "cron",
      // cron reads an unescaped % as a newline.
      text: `17 3 * * * cd ${quote(root)} && PATH=${quote(path)} ${bin === "idiom" ? bin : quote(bin)} nightly >> .idiom/reports/nightly.log 2>&1`.replaceAll(
        "%",
        "\\%",
      ),
    };
  const slug =
    basename(root)
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, "-")
      .replaceAll(/^-+|-+$/g, "") || "project";
  const label = `build.idiom.nightly.${slug}`;
  const plist = join(
    options.home ?? environment.HOME ?? "~",
    "Library/LaunchAgents",
    `${label}.plist`,
  );
  const log = join(root, ".idiom/reports/nightly.log");
  const install = `launchctl bootstrap gui/$(id -u) ${quote(plist)}`;
  const text = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    `<!-- Save as ${plist}, then load it: ${install} -->`,
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${xml(label)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    `    <string>${xml(bin)}</string>`,
    "    <string>nightly</string>",
    "  </array>",
    "  <key>WorkingDirectory</key>",
    `  <string>${xml(root)}</string>`,
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    "    <key>PATH</key>",
    `    <string>${xml(path)}</string>`,
    "  </dict>",
    "  <key>StartCalendarInterval</key>",
    "  <dict>",
    "    <key>Hour</key>",
    "    <integer>3</integer>",
    "    <key>Minute</key>",
    "    <integer>17</integer>",
    "  </dict>",
    "  <key>StandardOutPath</key>",
    `  <string>${xml(log)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${xml(log)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
  return {
    kind: "launchd",
    text,
    path: plist,
    install,
  };
}
