import type { Page } from "playwright";

/**
 * What one captured tuple rendered, as names a change can be matched
 * against: classes, ids, test ids, component names (React and Vue dev
 * builds) and stylesheet sources. Recorded in `observations.json` so the
 * build gate can rank states by whether they show the changed surface.
 */
export type RenderedSurface = {
  version: 1;
  classes: string[];
  ids: string[];
  testIds: string[];
  components: string[];
  sheets: string[];
  /** A list hit its cap; absence from it proves less. */
  truncated?: boolean | undefined;
};

/** Entries kept per list. */
export const RENDERED_SURFACE_CAP = 4000;

/** A surface token as the page-side matcher needs it. */
export type SurfaceMatchToken = {
  kind: "class" | "module" | "id" | "testId" | "component" | "sheet";
  value: string;
  stem?: string | undefined;
};

/**
 * Whether a rendered class is a CSS-module class for `key`: equal to it, or
 * a hashed name whose segments (split on `_` runs and `--`) include the key
 * next to a hash-like segment. Covers Next (`Toolbar_toolbar__k3x9`), Vite
 * (`_toolbar_1x2y3_4`) and webpack (`Toolbar-module__toolbar___abc12`).
 * `toolbarish` and `my-toolbar-x` do not match `toolbar`.
 *
 * Self-contained: the probe passes its source into the page.
 */
export function moduleClassMatches(className: string, key: string): boolean {
  if (className === key) return true;
  const segments = className.split(/_+|-{2,}/).filter(Boolean);
  if (!segments.includes(key)) return false;
  return segments.some(
    (segment) =>
      segment !== key &&
      segment.length >= 3 &&
      /^[A-Za-z0-9-]+$/.test(segment) &&
      (/\d/.test(segment) || /[a-z][A-Z]|[A-Z][a-z]*[A-Z]/.test(segment)) &&
      !/-module$/.test(segment),
  );
}

/**
 * The tokens a rendered inventory shows, formatted for plan lines
 * (`.toolbar`, `#x`, `[data-testid=x]`, `<Toolbar>`, `sheet:path`).
 */
export function surfaceMatches(
  surface: Pick<
    RenderedSurface,
    "classes" | "ids" | "testIds" | "components" | "sheets"
  >,
  tokens: SurfaceMatchToken[],
): string[] {
  const classes = new Set(surface.classes);
  const ids = new Set(surface.ids);
  const testIds = new Set(surface.testIds);
  const components = new Set(surface.components);
  const matched: string[] = [];
  for (const token of tokens) {
    switch (token.kind) {
      case "class":
        if (classes.has(token.value)) matched.push(`.${token.value}`);
        break;
      case "id":
        if (ids.has(token.value)) matched.push(`#${token.value}`);
        break;
      case "testId":
        if (testIds.has(token.value))
          matched.push(`[data-testid=${token.value}]`);
        break;
      case "component":
        if (components.has(token.value)) matched.push(`<${token.value}>`);
        break;
      case "module":
        if (
          surface.classes.some((name) => moduleClassMatches(name, token.value))
        )
          matched.push(`.${token.stem ? `${token.stem}.` : ""}${token.value}`);
        break;
      case "sheet": {
        const path = token.value.replace(/^\/+/, "");
        if (
          surface.sheets.some(
            (sheet) => sheet === path || sheet.endsWith(`/${path}`),
          )
        )
          matched.push(`sheet:${path}`);
        break;
      }
    }
  }
  return [...new Set(matched)];
}

/**
 * One pass over the document. Never throws: a page that cannot be read
 * leaves the field absent rather than failing the tuple.
 */
export async function observeRenderedSurface(
  page: Page,
): Promise<RenderedSurface | undefined> {
  try {
    return await page.evaluate((cap: number) => {
      const classes = new Set<string>();
      const ids = new Set<string>();
      const testIds = new Set<string>();
      const components = new Set<string>();
      const sheets = new Set<string>();
      const visited = new WeakSet<object>();
      const componentName = /^[A-Z][A-Za-z0-9]{2,}$/;
      type Fiber = {
        return?: Fiber | null;
        type?: unknown;
      };
      const nameOf = (type: unknown, depth = 0): string | undefined => {
        if (typeof type !== "function" && typeof type !== "object")
          return undefined;
        if (type === null) return undefined;
        const value = type as {
          displayName?: unknown;
          name?: unknown;
          __name?: unknown;
          render?: unknown;
          type?: unknown;
        };
        const name = value.displayName ?? value.__name ?? value.name;
        if (typeof name === "string" && componentName.test(name)) return name;
        // forwardRef wraps the component in `render`, memo in `type`.
        if (depth < 3)
          return (
            nameOf(value.render, depth + 1) ?? nameOf(value.type, depth + 1)
          );
        return undefined;
      };
      const walkFiber = (start: Fiber) => {
        let fiber: Fiber | null | undefined = start;
        for (let depth = 0; fiber && depth < 50; depth++) {
          if (visited.has(fiber)) return;
          visited.add(fiber);
          const name = nameOf(fiber.type);
          if (name) components.add(name);
          fiber = fiber.return;
        }
      };
      const visit = (element: Element) => {
        for (const name of element.classList) classes.add(name);
        if (element.id) ids.add(element.id);
        for (const attribute of [
          "data-testid",
          "data-test-id",
          "data-component",
        ]) {
          const value = element.getAttribute(attribute);
          if (value) testIds.add(value);
        }
        const record = element as unknown as Record<string, unknown>;
        for (const key in record) {
          if (key.startsWith("__reactFiber$")) {
            walkFiber(record[key] as Fiber);
            break;
          }
        }
        const vue = record.__vueParentComponent as
          | { type?: unknown }
          | undefined;
        if (vue) {
          const name = nameOf(vue.type);
          if (name) components.add(name);
        }
      };
      for (const element of document.querySelectorAll("*")) {
        visit(element);
        const root = (element as HTMLElement).shadowRoot;
        if (root) for (const inner of root.querySelectorAll("*")) visit(inner);
      }
      for (const sheet of document.styleSheets) {
        if (!sheet.href) continue;
        try {
          sheets.add(new URL(sheet.href).pathname);
        } catch {
          sheets.add(sheet.href);
        }
      }
      for (const style of document.querySelectorAll(
        "style[data-vite-dev-id]",
      )) {
        const id = style.getAttribute("data-vite-dev-id");
        if (id) sheets.add(id);
      }
      let truncated = false;
      const list = (values: Set<string>) => {
        const sorted = [...values].sort();
        if (sorted.length > cap) truncated = true;
        return sorted.slice(0, cap);
      };
      return {
        version: 1 as const,
        classes: list(classes),
        ids: list(ids),
        testIds: list(testIds),
        components: list(components),
        sheets: list(sheets),
        ...(truncated ? { truncated: true } : {}),
      };
    }, RENDERED_SURFACE_CAP);
  } catch {
    return undefined;
  }
}

/**
 * Page-side: for each element path, whether it lies inside, contains, or
 * sits within `nearPx` of an element of the changed surface. `matched` is
 * how many surface elements the page shows (0 → leave the probe unscoped).
 * Self-contained; passed to `page.evaluate`.
 */
export function markNearSurface(input: {
  paths: string[];
  tokens: SurfaceMatchToken[];
  nearPx: number;
}): { matched: number; near: boolean[] } {
  const moduleMatches = (className: string, key: string): boolean => {
    if (className === key) return true;
    const segments = className.split(/_+|-{2,}/).filter(Boolean);
    if (!segments.includes(key)) return false;
    return segments.some(
      (segment) =>
        segment !== key &&
        segment.length >= 3 &&
        /^[A-Za-z0-9-]+$/.test(segment) &&
        (/\d/.test(segment) || /[a-z][A-Z]|[A-Z][a-z]*[A-Z]/.test(segment)) &&
        !/-module$/.test(segment),
    );
  };
  const components = new Set(
    input.tokens
      .filter((token) => token.kind === "component")
      .map((token) => token.value),
  );
  type Fiber = { return?: Fiber | null; type?: unknown };
  const nameOf = (type: unknown): string | undefined => {
    if (
      type === null ||
      (typeof type !== "function" && typeof type !== "object")
    )
      return undefined;
    const value = type as {
      displayName?: unknown;
      name?: unknown;
      __name?: unknown;
    };
    const name = value.displayName ?? value.__name ?? value.name;
    return typeof name === "string" ? name : undefined;
  };
  const ownComponent = (element: Element): boolean => {
    if (!components.size) return false;
    const record = element as unknown as Record<string, unknown>;
    for (const key in record) {
      if (!key.startsWith("__reactFiber$")) continue;
      // Only the nearest component: its root element stands for it.
      let fiber = record[key] as Fiber | null | undefined;
      for (let depth = 0; fiber && depth < 50; depth++) {
        const name = nameOf(fiber.type);
        if (typeof fiber.type !== "string" && name) return components.has(name);
        fiber = fiber.return;
      }
      return false;
    }
    const vue = record.__vueParentComponent as { type?: unknown } | undefined;
    const name = vue ? nameOf(vue.type) : undefined;
    return name !== undefined && components.has(name);
  };
  const matches = (element: Element): boolean => {
    for (const token of input.tokens) {
      if (token.kind === "class" && element.classList.contains(token.value))
        return true;
      if (token.kind === "id" && element.id === token.value) return true;
      if (
        token.kind === "testId" &&
        (element.getAttribute("data-testid") === token.value ||
          element.getAttribute("data-test-id") === token.value)
      )
        return true;
      if (token.kind === "module")
        for (const name of element.classList)
          if (moduleMatches(name, token.value)) return true;
    }
    return ownComponent(element);
  };
  const surface: Element[] = [];
  for (const element of document.querySelectorAll("*"))
    if (matches(element)) surface.push(element);
  // Outermost only: a descendant adds nothing to inside/near.
  const outermost = surface.filter(
    (element) =>
      !surface.some((other) => other !== element && other.contains(element)),
  );
  const rects = outermost
    .slice(0, 200)
    .map((element) => element.getBoundingClientRect())
    .filter((rect) => rect.width > 0 || rect.height > 0);
  const near = input.paths.map((path) => {
    let element: Element | null = null;
    try {
      element = document.querySelector(path);
    } catch {
      element = null;
    }
    if (!element) return false;
    for (const area of outermost)
      if (area.contains(element) || element.contains(area)) return true;
    const rect = element.getBoundingClientRect();
    return rects.some((area) => {
      const dx = Math.max(area.left - rect.right, rect.left - area.right, 0);
      const dy = Math.max(area.top - rect.bottom, rect.top - area.bottom, 0);
      return Math.hypot(dx, dy) <= input.nearPx;
    });
  });
  return { matched: outermost.length, near };
}
