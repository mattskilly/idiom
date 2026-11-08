import type { Project } from "../schemas/project.js";

/** Stable cause ids for an application server that could not start. */
export type ServerFailureCause =
  | "server-exited"
  | "server-timeout"
  | "server-spawn"
  | "port-pinned"
  | "port-in-use";

const TAIL_LINE_LIMIT = 240;

/** Names of environment variables whose values are treated as secrets. */
export const SECRET_NAME = /_(TOKEN|SECRET|KEY)$/;

/** Replace the values of secret-named variables wherever they appear. */
export function redact(value: string, environment: NodeJS.ProcessEnv): string {
  let result = value;
  for (const [name, secret] of Object.entries(environment)) {
    if (SECRET_NAME.test(name) && secret !== undefined && secret.length > 0) {
      result = result.split(secret).join(`[redacted ${name}]`);
    }
  }
  return result;
}

// The env-var secret suffix applied to query keys, also accepted as the whole
// key, so `?token=` and `?api_key=` are both caught.
const SECRET_QUERY_KEY = /(?:^|_)(TOKEN|SECRET|KEY)$/;

/**
 * A URL with the values of secret-named query keys replaced. Every other key,
 * value and its encoding is kept in order; the fragment, which a browser
 * never sends, is dropped. Unparseable input is returned unchanged.
 */
export function redactUrlSecrets(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const hashAt = url.indexOf("#");
  const withoutHash = hashAt === -1 ? url : url.slice(0, hashAt);
  const queryAt = withoutHash.indexOf("?");
  if (queryAt === -1 || parsed.search === "") return withoutHash;
  const query = withoutHash
    .slice(queryAt + 1)
    .split("&")
    .map((pair) => {
      const equals = pair.indexOf("=");
      if (equals === -1) return pair;
      const rawKey = pair.slice(0, equals);
      let key: string;
      try {
        key = decodeURIComponent(rawKey.replace(/\+/g, " "));
      } catch {
        key = rawKey;
      }
      return SECRET_QUERY_KEY.test(key.toUpperCase().replace(/-/g, "_"))
        ? `${rawKey}=[redacted]`
        : pair;
    })
    .join("&");
  return `${withoutHash.slice(0, queryAt)}?${query}`;
}

function tailLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-2)
    .map((line) =>
      line.length <= TAIL_LINE_LIMIT
        ? line
        : `${line.slice(0, TAIL_LINE_LIMIT - 1)}…`,
    );
}

/**
 * The last one or two non-empty lines of a server's stderr (or, when stderr
 * is empty, of its combined output), capped and redacted for a one-line cause.
 */
export function stderrTail(
  stderr: string,
  fallback: string,
  environment: NodeJS.ProcessEnv,
): string {
  const lines = tailLines(stderr);
  const chosen = lines.length > 0 ? lines : tailLines(fallback);
  if (chosen.length === 0) return "no output";
  return redact(chosen.join(" / "), environment);
}

// The name must sit right before the complaint (or right after "environment
// variable"), so a log prefix such as `ERROR:` is never mistaken for it.
const MISSING_ENV = [
  /\b([A-Z][A-Z0-9_]{2,})["'`]?(?:\s+(?:environment variable|env var))?\s+(?:is not set|is not defined|is required|must be set|is missing|is undefined|not set)\b/g,
  /\b(?:missing|required|undefined)\b[^\n]{0,40}?\b(?:environment variable|env var)s?:?\s+["'`]?([A-Z][A-Z0-9_]{2,})\b/gi,
];
const NOT_A_VARIABLE = new Set(["ERROR", "WARN", "WARNING", "INFO", "FATAL"]);

/** A variable the output says is missing, if it names one. */
export function missingEnvironmentVariable(output: string): string | undefined {
  for (const pattern of MISSING_ENV)
    for (const match of output.matchAll(pattern)) {
      const name = match[1];
      if (
        name !== undefined &&
        /^[A-Z][A-Z0-9_]{2,}$/.test(name) &&
        !NOT_A_VARIABLE.has(name)
      )
        return name;
    }
  return undefined;
}

function urlPort(url: URL): number {
  return url.port === ""
    ? url.protocol === "https:"
      ? 443
      : 80
    : Number(url.port);
}

/**
 * The fix for a known startup failure. Advisory text only: it never changes
 * what the run does, so a wrong guess costs a sentence, not a result.
 */
export function serverFailureHint(options: {
  cause: ServerFailureCause;
  output: string;
  project: Project;
  /** The project's own `server.port`, when capture bound a different one. */
  configuredPort?: number | undefined;
  /** The port already in use, when the cause is `port-in-use`. */
  port?: number | undefined;
}): string {
  const { server } = options.project;
  if (options.cause === "port-pinned")
    return `set "server.fixedPort": true in .idiom/project.json, or pass --port ${options.configuredPort ?? server.port}`;
  const missing = missingEnvironmentVariable(options.output);
  if (missing !== undefined)
    return server.env[missing] === undefined
      ? `add ${missing} to server.env in .idiom/project.json`
      : `${missing} is already in server.env; check its value, or whether server.start passes it through`;
  if (
    options.cause === "port-in-use" ||
    /\bEADDRINUSE\b/.test(options.output)
  ) {
    const port =
      /\bEADDRINUSE\b[^\n]*?:(\d{2,5})\b/.exec(options.output)?.[1] ??
      String(options.port ?? server.port);
    return `stop the process on port ${port}, or change server.port`;
  }
  if (options.cause === "server-timeout") {
    const ready = new URL(server.readyUrl);
    for (const match of options.output.matchAll(/https?:\/\/[^\s'"<>)\]]+/g)) {
      try {
        const reported = new URL(match[0]);
        if (urlPort(reported) !== urlPort(ready))
          return `server.readyUrl may be wrong: the server reported ${reported.origin}`;
      } catch {
        // Not a URL after all.
      }
    }
    return `make server.readyUrl (${server.readyUrl}) return 200 once the app is up, or raise server.startupTimeoutMs`;
  }
  if (options.cause === "server-spawn")
    return "check server.start in .idiom/project.json names a command that exists";
  return "run server.start yourself to see why it exits; idiom doctor <flow> repeats the start";
}
