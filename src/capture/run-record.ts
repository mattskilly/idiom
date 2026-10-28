import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { IdiomError } from "../errors.js";
import { captureTupleKey } from "./resolve.js";
import { controlTimingSchema, phaseTimingSchema } from "./timings.js";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
export const coordinateSchema = z
  .object({ state: id, viewport: id, colorScheme: z.enum(["light", "dark"]) })
  .strict();
export const runRecordSchema = z
  .object({
    version: z.literal(1),
    captureSettingsIdentity: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    flow: id,
    source: z
      .object({ commit: z.string().min(1), dirty: z.boolean() })
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
