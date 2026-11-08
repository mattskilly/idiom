import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { IdiomError } from "../errors.js";
import { pressureReasons } from "./host-pressure.js";
import { captureTupleKey } from "./resolve.js";
import { controlTimingSchema, phaseTimingSchema } from "./timings.js";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
export const coordinateSchema = z
  .object({ state: id, viewport: id, colorScheme: z.enum(["light", "dark"]) })
  .strict();
export const timeoutDiagnosticSchema = z
  .object({
    kind: z.enum(["navigation", "readiness"]),
    timeoutMs: z.number().finite().positive(),
  })
  .strict();
const loadSchema = z
  .tuple([
    z.number().finite().nonnegative(),
    z.number().finite().nonnegative(),
    z.number().finite().nonnegative(),
  ])
  .nullable();
export const runRecordSchema = z
  .object({
    version: z.literal(1),
    status: z.enum(["running", "complete", "interrupted"]).optional(),
    runId: z.string().min(1).optional(),
    owner: z
      .object({
        pid: z.number().int().positive(),
        start: z.string().optional(),
      })
      .strict()
      .optional(),
    startedAt: z.string().datetime().optional(),
    updatedAt: z.string().datetime().optional(),
    endedAt: z.string().datetime().optional(),
    completedTuples: z.array(coordinateSchema).optional(),
    interruption: z
      .object({
        reason: z.enum(["signal", "process-gone", "capture-failed"]),
        signal: z.enum(["SIGINT", "SIGTERM"]).optional(),
      })
      .strict()
      .optional(),
    host: z
      .object({
        loadStart: loadSchema,
        loadEnd: loadSchema,
        coreCount: z.number().int().positive(),
        threshold: z.number().finite().positive(),
        readyStartMs: z.number().finite().positive().nullable(),
        readyEndMs: z.number().finite().positive().nullable(),
        pressureReasons: z.array(z.enum(["load", "ready-url-slowdown"])),
      })
      .strict()
      .optional(),
    retryCount: z.number().int().nonnegative().optional(),
    retries: z
      .array(
        coordinateSchema
          .extend({
            phase: z.enum(["capture", "probe"]),
            firstTimeout: timeoutDiagnosticSchema,
            doubledDeadlineMs: z.number().finite().positive(),
            outcome: z.enum(["passed", "timed-out", "failed"]),
          })
          .strict(),
      )
      .optional(),
    deferredTuples: z.array(coordinateSchema).optional(),
    captureSettingsIdentity: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    flow: id,
    source: z
      .object({
        commit: z.string().min(1),
        dirty: z.boolean(),
        ignoredDirtyPaths: z.array(z.string()).optional(),
        changedDuringCapture: z.boolean().optional(),
      })
      .strict(),
    declared: z.array(coordinateSchema),
    selected: z.array(coordinateSchema),
    viewports: z.array(
      z
        .object({
          name: id,
          width: z.number().positive(),
          height: z.number().positive(),
          touch: z.boolean().optional(),
        })
        .strict(),
    ),
    probe: z
      .object({
        policy: z.enum(["once-per-state", "everywhere", "unsupported"]),
        fallback: z.boolean(),
        intended: z.array(coordinateSchema),
        executed: z.array(coordinateSchema),
        /** Effective probe run target in ms; 0 = no target. Absent in older runs. */
        flowBudgetMs: z.number().int().min(0).optional(),
      })
      .strict(),
    timings: z
      .object({
        slowestControls: z.array(controlTimingSchema).max(5).optional(),
        build: phaseTimingSchema,
        start: phaseTimingSchema,
        tuples: z.array(
          coordinateSchema
            .extend({ total: phaseTimingSchema, probe: phaseTimingSchema })
            .strict(),
        ),
        probe: phaseTimingSchema,
        checks: phaseTimingSchema,
        capture: phaseTimingSchema.optional(),
      })
      .strict(),
    /** The prefers-reduced-motion mode every tuple was captured under. */
    capture: z.object({ reducedMotion: z.boolean() }).strict().optional(),
  })
  .strict()
  .superRefine((record, ctx) => {
    const keys = (tuples: Array<z.infer<typeof coordinateSchema>>) =>
      tuples.map(captureTupleKey);
    for (const field of ["declared", "selected"] as const)
      if (new Set(keys(record[field])).size !== record[field].length)
        ctx.addIssue({
          code: "custom",
          message: `duplicate ${field} coordinates`,
        });
    const subset = (
      values: Array<z.infer<typeof coordinateSchema>>,
      parent: Array<z.infer<typeof coordinateSchema>>,
      label: string,
    ) => {
      const allowed = new Set(keys(parent));
      if (
        values.some((tuple) => !allowed.has(captureTupleKey(tuple))) ||
        new Set(keys(values)).size !== values.length
      )
        ctx.addIssue({
          code: "custom",
          message: `invalid ${label} coordinates`,
        });
    };
    subset(record.selected, record.declared, "selected");
    subset(record.completedTuples ?? [], record.selected, "completed");
    if (
      record.status !== undefined &&
      (!record.runId ||
        !record.owner ||
        !record.startedAt ||
        !record.updatedAt ||
        !record.completedTuples)
    )
      ctx.addIssue({ code: "custom", message: "missing lifecycle fields" });
    if (
      record.status === "complete" &&
      record.completedTuples?.length !== record.selected.length
    )
      ctx.addIssue({
        code: "custom",
        message: "missing completed coordinates",
      });
    subset(record.retries ?? [], record.selected, "retry");
    subset(record.deferredTuples ?? [], record.selected, "deferred");
    subset(
      record.retries?.filter((retry) => retry.phase === "probe") ?? [],
      record.probe.intended,
      "probe retry",
    );
    if ((record.retryCount ?? 0) !== (record.retries?.length ?? 0))
      ctx.addIssue({ code: "custom", message: "retry count mismatch" });
    if (
      record.retries?.some(
        (retry) => retry.doubledDeadlineMs !== retry.firstTimeout.timeoutMs * 2,
      )
    )
      ctx.addIssue({ code: "custom", message: "retry deadline mismatch" });
    if (record.host) {
      const expected = pressureReasons(record.host);
      if (
        JSON.stringify([...record.host.pressureReasons].sort()) !==
        JSON.stringify([...expected].sort())
      )
        ctx.addIssue({ code: "custom", message: "inconsistent host pressure" });
    }
    if (
      (record.deferredTuples?.length ?? 0) > 0 &&
      (!record.host?.pressureReasons.length ||
        record.deferredTuples?.some(
          (tuple) =>
            !record.retries?.some(
              (retry) =>
                captureTupleKey(retry) === captureTupleKey(tuple) &&
                retry.phase === "capture" &&
                retry.outcome === "timed-out",
            ),
        ))
    )
      ctx.addIssue({ code: "custom", message: "invalid timeout deferral" });
    subset(record.probe.intended, record.selected, "intended probe");
    subset(record.probe.executed, record.probe.intended, "executed probe");
    subset(record.timings.tuples, record.selected, "timing");
    if (record.timings.tuples.length !== record.selected.length)
      ctx.addIssue({ code: "custom", message: "missing tuple timings" });
    const viewports = new Set(record.viewports.map((v) => v.name));
    if (
      viewports.size !== record.viewports.length ||
      record.declared.some((tuple) => !viewports.has(tuple.viewport))
    )
      ctx.addIssue({
        code: "custom",
        message: "invalid viewport declarations",
      });
  });
export type RunRecord = z.infer<typeof runRecordSchema>;
export async function loadRunRecord(
  directory: string,
): Promise<RunRecord | undefined> {
  let content: string;
  try {
    content = await readFile(join(directory, "run.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return runRecordSchema.parse(JSON.parse(content));
  } catch (error) {
    throw new IdiomError(`invalid run.json in ${directory}: ${String(error)}`);
  }
}
