import type { CallToolResult } from "@modelcontextprotocol/server";
import type { ValidateFunction } from "ajv/dist/2020.js";
import { expect } from "vitest";
import { validateToolResult } from "./mcp-support.js";

/** Tools test/mcp-output-schemas-browser.test.ts calls; they need Chromium. */
export const BROWSER_TOOLS = [
  "idiom_quick",
  "idiom_check",
  "idiom_issue",
  "idiom_decide",
  "idiom_fix_plan",
  "idiom_verify",
] as const;

/** Tools test/mcp-output-schemas.test.ts calls without a browser. */
export const PLAIN_TOOLS = [
  "idiom_init",
  "idiom_setup_prompt",
  "idiom_context",
  "idiom_flows",
  "idiom_coverage",
  "idiom_ready",
  "idiom_doctor",
  "idiom_design_add",
  "idiom_choose",
  "idiom_learn",
  "idiom_tickets",
  "idiom_sweep",
  "idiom_baseline",
  "idiom_brief_triage",
  "idiom_brief_plan",
  "idiom_brief_record",
  "idiom_brief_decide",
  "idiom_brief_export",
  "idiom_brief_attach",
] as const;

/**
 * Asserts a call succeeded, validates it against the advertised outputSchema,
 * records the tool in `called` and returns its structuredContent.
 */
export function validOutput<T = Record<string, unknown>>(
  called: Set<string>,
  validators: Map<string, ValidateFunction>,
  name: string,
  response: unknown,
): T {
  const result = response as CallToolResult;
  expect(result.isError, `${name}: ${JSON.stringify(result.content)}`).not.toBe(
    true,
  );
  validateToolResult(validators, name, result);
  called.add(name);
  return result.structuredContent as T;
}
