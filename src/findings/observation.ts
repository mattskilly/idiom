import type { AcceptanceAction } from "../schemas/acceptance.js";
import { jsonRecord } from "./json.js";

export function observed(
  action: AcceptanceAction,
  result: object,
  timing?: { elapsedMs?: number; windowMs?: number },
) {
  return {
    action,
    result: jsonRecord(result),
    timing: timing ?? { reason: "Timing was not recorded in this capture." },
  };
}
