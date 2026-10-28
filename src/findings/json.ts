import type { z } from "zod";

/** Omit undefined artifact fields, retaining only the serialized evidence. */
export function jsonRecord(
  value: object,
): Record<string, z.infer<ReturnType<typeof z.json>>> {
  return JSON.parse(JSON.stringify(value));
}
