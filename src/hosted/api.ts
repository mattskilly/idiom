import { ipAddress, waitUntil } from "@vercel/functions";
import { checkBotId } from "botid/server";
import { privateBlobStore } from "./blob.js";
import { cleanupReports } from "./cleanup.js";
import { enabled, hostedConfig, LIMITS } from "./config.js";
import { failure, HostedError, statusFor } from "./errors.js";
import { AdmissionLedger } from "./ledger.js";
import { renderHostedReport, reportHeaders } from "./render.js";
import { Reports, randomCapability } from "./reports.js";
import { cleanupAbandoned, deadline, runSandbox } from "./sandbox.js";
import { boundedBody, parseInput, type Stage } from "./schema.js";
import { resolvePublic } from "./ssrf.js";

const stages: Record<Stage, string> = {
  admitted: "Review admitted. Budget reserved.",
  starting: "Starting an isolated browser.",
  reviewing: "Running measured checks and the strict read-only probe.",
  publishing: "Saving the report and its evidence.",
  complete: "Report ready.",
};
export type ApiDependencies = {
  env: NodeJS.ProcessEnv;
  now: () => number;
  bot: (request: Request) => Promise<boolean>;
  ip: (request: Request) => string | undefined;
  resolve: typeof resolvePublic;
  ledger: AdmissionLedger;
  reports: Reports;
  run: typeof runSandbox;
  cleanupSandboxes: typeof cleanupAbandoned;
  lateCleanup: (promise: Promise<unknown>) => void;
};
export function productionDependencies(): ApiDependencies {
  const secret = process.env.IDIOM_HOSTED_IP_SECRET ?? "";
  const ledger = new AdmissionLedger(privateBlobStore, secret);
  return {
    env: process.env,
    now: Date.now,
    ip: ipAddress,
    resolve: resolvePublic,
    ledger,
    reports: new Reports(privateBlobStore, ledger),
    run: runSandbox,
    cleanupSandboxes: cleanupAbandoned,
    lateCleanup: waitUntil,
    bot: async (request) => {
      const result = await checkBotId({
        developmentOptions: { isDevelopment: false },
        advancedOptions: { headers: Object.fromEntries(request.headers) },
      });
      return result.isHuman && !result.isBot && !result.bypassed;
    },
  };
}
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      ...reportHeaders,
      "content-type": "application/json; charset=utf-8",
    },
  });
function sameOrigin(request: Request) {
  if (
    request.headers.get("origin") !== new URL(request.url).origin ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    throw new HostedError("invalid-input");
}
export async function hostedApi(
  request: Request,
  route: "config" | "review" | "report" | "asset" | "delete" | "cleanup",
  deps: ApiDependencies = productionDependencies(),
): Promise<Response> {
  try {
    if (route === "config") {
      if (request.method !== "GET") return json({}, 405);
      if (!enabled(deps.env)) return json({ enabled: false });
      // Availability only; never the cap, spend or any ledger detail.
      try {
        const config = hostedConfig(deps.env);
        const open = await deps.ledger.capacity(config.cap);
        return json({
          enabled: true,
          available: open,
          ...(open ? {} : { reason: "cap-reached" }),
        });
      } catch {
        return json({ enabled: true, available: false, reason: "unavailable" });
      }
    }
    if (route === "review") {
      if (request.method !== "POST") return json({}, 405);
      const config = hostedConfig(deps.env);
      sameOrigin(request);
      if (!(await deps.bot(request).catch(() => false)))
        throw new HostedError("bot");
      const input = await parseInput(request);
      await deps.resolve(input.target, undefined, request.signal);
      if (input.reference)
        await deps.resolve(input.reference, undefined, request.signal);
      request.signal.throwIfAborted();
      const id = randomCapability();
      const admitted = await deps.ledger.admit(
        deps.ip(request),
        id,
        config.cap,
      );
      const controller = new AbortController();
      const deadlineAt = admitted.admittedAt + LIMITS.runMs;
      const signal = AbortSignal.any([
        request.signal,
        controller.signal,
        AbortSignal.timeout(Math.max(1, deadlineAt - deps.now())),
      ]);
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(output) {
          const send = (event: unknown) => {
            if (!controller.signal.aborted && !request.signal.aborted)
              output.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          };
          const stage = (value: Stage) =>
            send({ type: "progress", stage: value, message: stages[value] });
          try {
            stage("admitted");
            const result = await deadline(
              deps.run(input, config, {
                id,
                deadlineAt,
                signal,
                stage,
                lateCleanup: deps.lateCleanup,
              }),
              signal,
            );
            stage("publishing");
            const publication = deps.reports.publish(
              id,
              result.report,
              result.assets,
              signal,
            );
            // A late Blob operation is rolled back by publish's signal checks.
            deps.lateCleanup(publication.catch(() => undefined));
            const saved = await deadline(publication, signal);
            stage("complete");
            send({ type: "result", ...saved });
          } catch (error) {
            send(failure(signal.aborted ? new HostedError("timeout") : error));
          } finally {
            if (!controller.signal.aborted) output.close();
          }
        },
        cancel() {
          controller.abort();
        },
      });
      return new Response(stream, {
        headers: {
          ...reportHeaders,
          "content-type": "application/x-ndjson",
          "x-accel-buffering": "no",
        },
      });
    }
    const url = new URL(request.url);
    const id = url.searchParams.get("id") ?? "";
    if (route === "report") {
      if (request.method !== "GET" && request.method !== "HEAD")
        return json({}, 405);
      if (request.method === "HEAD") {
        await deps.reports.manifest(id);
        return new Response(null, { headers: reportHeaders });
      }
      const { report, expiresAt } = await deps.reports.read(id);
      return new Response(renderHostedReport(id, report, expiresAt), {
        headers: reportHeaders,
      });
    }
    if (route === "asset") {
      if (request.method !== "GET" && request.method !== "HEAD")
        return json({}, 405);
      const name = url.searchParams.get("name") ?? "";
      const headers = { ...reportHeaders, "content-type": "image/png" };
      if (request.method === "HEAD") {
        await deps.reports.assetMetadata(id, name);
        return new Response(null, { headers });
      }
      const bytes = await deps.reports.asset(id, name);
      return new Response(new Uint8Array(bytes), { headers });
    }
    if (route === "delete") {
      if (request.method !== "POST") return json({}, 405);
      sameOrigin(request);
      const body = JSON.parse((await boundedBody(request, 256)).toString()) as {
        token?: string;
      };
      await deps.reports.delete(
        id,
        typeof body.token === "string" ? body.token : "",
      );
      return json({ deleted: true });
    }
    if (request.method !== "GET") return json({}, 405);
    if (
      !deps.env.CRON_SECRET ||
      request.headers.get("authorization") !== `Bearer ${deps.env.CRON_SECRET}`
    )
      return json({}, 401);
    const reports = await cleanupReports(
      deps.reports,
      deps.reports.store,
      deps.now(),
    );
    const sandboxes = await deps.cleanupSandboxes(deps.now());
    return json({ ...reports, sandboxes }, reports.failed ? 503 : 200);
  } catch (error) {
    const envelope = failure(error);
    return json(envelope, statusFor(envelope.code));
  }
}
