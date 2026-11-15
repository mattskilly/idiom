import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { projectSchema } from "../schemas/project.js";

/** Narrower than this reads as a phone. */
const PHONE_MAX = 640;
/** At least this wide reads as a desktop. */
const DESKTOP_MIN = 1200;

type Viewport = { name: string; width: number };

/**
 * One line when the configured viewports jump from phone straight to desktop
 * with nothing in between (no 768- or 1024-wide tablet); undefined otherwise.
 * A suggestion only: defaults never change.
 */
export function tabletViewportSuggestion(
  viewports: readonly Viewport[],
): string | undefined {
  const phones = viewports.filter((viewport) => viewport.width < PHONE_MAX);
  const desktops = viewports.filter(
    (viewport) => viewport.width >= DESKTOP_MIN,
  );
  const between = viewports.some(
    (viewport) => viewport.width >= PHONE_MAX && viewport.width < DESKTOP_MIN,
  );
  if (phones.length === 0 || desktops.length === 0 || between) return undefined;
  const phone = phones.reduce((widest, viewport) =>
    viewport.width > widest.width ? viewport : widest,
  );
  const desktop = desktops.reduce((narrowest, viewport) =>
    viewport.width < narrowest.width ? viewport : narrowest,
  );
  return `Suggestion: viewports skip from phone (${phone.name} ${phone.width}px) to desktop (${desktop.name} ${desktop.width}px); add a tablet viewport such as { "name": "tablet", "width": 768, "height": 1024 } (or 1024 wide) to viewports in .idiom/project.json.`;
}

/**
 * The suggestion for a project file's text (or, when the file is absent,
 * for `fallback`, the content init would write). Unreadable or invalid
 * configuration yields no suggestion: validation reports that elsewhere.
 */
export async function projectViewportSuggestion(
  projectDirectory: string,
  fallback?: string | undefined,
): Promise<string | undefined> {
  let text: string | undefined;
  try {
    text = await readFile(
      join(projectDirectory, ".idiom", "project.json"),
      "utf8",
    );
  } catch {
    text = fallback;
  }
  if (text === undefined) return undefined;
  try {
    const parsed = projectSchema.safeParse(JSON.parse(text));
    return parsed.success
      ? tabletViewportSuggestion(parsed.data.viewports)
      : undefined;
  } catch {
    return undefined;
  }
}
