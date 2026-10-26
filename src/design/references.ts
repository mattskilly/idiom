import type { SelectedViewport } from "../capture/types.js";
import type { DesignDeclaration, DesignLocation } from "../schemas/design.js";
import { parseFigmaUrl } from "./figma/url.js";

export type ResolvedDesignRef = {
  name: string;
  source: DesignLocation;
  figma: boolean;
  viewport?: string | undefined;
  colorScheme?: "light" | "dark" | undefined;
};

/** Every declared reference, named: `figma`, `site` or `design` by default, de-duplicated with -2, -3. */
export function designReferences(state: {
  design?: DesignDeclaration | undefined;
}): ResolvedDesignRef[] {
  const declaration = state.design;
  if (declaration === undefined) return [];
  const entries = (
    Array.isArray(declaration) ? declaration : [declaration]
  ).map(
    (
      entry,
    ): Omit<ResolvedDesignRef, "name" | "figma"> & {
      name?: string | undefined;
    } => {
      if (typeof entry === "string") return { source: entry };
      if ("site" in entry) {
        const { site, ...options } = entry;
        return { ...options, source: { site } };
      }
      return entry;
    },
  );
  const explicit = new Set(
    entries.flatMap((entry) => (entry.name ? [entry.name] : [])),
  );
  const used = new Set<string>();
  return entries.map((entry) => {
    const figma =
      typeof entry.source === "string" &&
      parseFigmaUrl(entry.source) !== undefined;
    let name = entry.name;
    if (!name) {
      const base = figma
        ? "figma"
        : typeof entry.source === "string"
          ? "design"
          : "site";
      name = base;
      for (let n = 2; used.has(name) || explicit.has(name); n++)
        name = `${base}-${n}`;
    }
    used.add(name);
    return {
      name,
      source: entry.source,
      figma,
      ...(entry.viewport === undefined ? {} : { viewport: entry.viewport }),
      ...(entry.colorScheme === undefined
        ? {}
        : { colorScheme: entry.colorScheme }),
    };
  });
}

/** An explicit viewport wins; otherwise the nearest width, earlier viewport on ties. */
export function selectDesignViewport(
  ref: Pick<ResolvedDesignRef, "viewport">,
  frameWidth: number,
  viewports: ReadonlyArray<Pick<SelectedViewport, "name" | "width">>,
): string | undefined {
  if (ref.viewport !== undefined) return ref.viewport;
  let best: (typeof viewports)[number] | undefined;
  for (const viewport of viewports)
    if (
      !best ||
      Math.abs(viewport.width - frameWidth) < Math.abs(best.width - frameWidth)
    )
      best = viewport;
  return best?.name;
}
