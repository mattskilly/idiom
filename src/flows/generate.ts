import { createHash } from "node:crypto";
import {
  localOrigin,
  selectColorSchemes,
  selectViewports,
} from "../capture/resolve.js";
import { IdiomError } from "../errors.js";
import { flowSchema, routeStateId } from "../schemas/flow.js";
import type { Project } from "../schemas/project.js";
import { openFlowBrowser } from "./browser.js";
import { type Discovery, discoverFlowRoutes } from "./discover.js";

export type Generation = {
  content?: string;
  stateCount: number;
  routeCount: number;
  setup: string[];
  todos: string[];
  warnings: string[];
};
export type GenerateFlow = (options: {
  directory: string;
  project: Project;
  surface?: string | undefined;
}) => Promise<Generation>;

export function constructSiteFlow(
  project: Project,
  discovery: Discovery,
  surface?: string,
): Generation {
  const origin = new URL(project.server.readyUrl).origin;
  const display = (value: string) => value.replaceAll(origin, "");
  discovery = {
    routes: discovery.routes.map((route) => ({
      ...route,
      sources: route.sources.map(display),
      ...(route.setup ? { setup: display(route.setup) } : {}),
      ...(route.reason ? { reason: display(route.reason) } : {}),
    })),
    warnings: discovery.warnings.map(display),
  };
  const surfaces = project.surfaces.map((s) => s.id);
  const selected = surface ?? (surfaces.length === 1 ? surfaces[0] : undefined);
  if (
    (selected !== undefined && !surfaces.includes(selected)) ||
    (surfaces.length > 1 && selected === undefined)
  )
    throw new IdiomError(
      `Flow generation requires --surface <id>; choose from: ${surfaces.join(", ") || "(no declared surfaces)"}`,
    );
  const todos: string[] = [];
  const setup: string[] = [];
  const counts = new Map<string, number>();
  for (const route of discovery.routes)
    counts.set(
      routeStateId(route.route),
      (counts.get(routeStateId(route.route)) ?? 0) + 1,
    );
  const states = discovery.routes.flatMap((route) => {
    if (!route.path) {
      todos.push(
        `TODO: ${route.route} (${route.sources.join(", ")}): ${route.reason}`,
      );
      return [];
    }
    const base = routeStateId(route.route);
    const id =
      (counts.get(base) ?? 0) > 1
        ? `${base}-${createHash("sha256").update(route.route).digest("hex").slice(0, 10)}`
        : base;
    if (route.setup)
      setup.push(
        `TODO: requires setup for ${route.route}: redirected to ${route.setup}. Add your authentication/seed command to this flow's setup array before capture.`,
      );
    if (route.reason) todos.push(`Unverified ${route.route}: ${route.reason}`);
    return [
      {
        id,
        description: `${route.route} — ${route.sources.join(", ")}${route.setup ? `; TODO: requires setup (login destination ${route.setup})` : ""}${route.reason ? `; unverified: ${route.reason}` : ""}`,
        url: route.path,
        expect: { status: 200, path: route.expectedPath ?? route.path },
      },
    ];
  });
  if (discovery.routes.length === 0)
    return {
      routeCount: 0,
      stateCount: 0,
      setup,
      todos,
      warnings: discovery.warnings,
    };
  const raw = {
    id: "site",
    title: "Site routes",
    intent: [
      "Generated route starting point. Add interaction states manually or with learn.",
      ...setup,
      ...todos,
      ...discovery.warnings,
    ],
    target: { kind: "web" },
    setup: [],
    ...(selected === undefined ? {} : { surface: selected }),
    viewports: project.viewports.map((v) => v.name),
    colorSchemes: project.colorSchemes,
    states,
  };
  const parsed = flowSchema.parse(raw);
  selectViewports(project, parsed);
  selectColorSchemes(project, parsed);
  return {
    content: `${JSON.stringify(raw, null, 2)}\n`,
    routeCount: discovery.routes.length,
    stateCount: states.length,
    setup,
    todos,
    warnings: discovery.warnings,
  };
}

export const generateSiteFlow: GenerateFlow = async ({
  directory,
  project,
  surface,
}) => {
  localOrigin(project.server.readyUrl);
  // Validate surface ownership before starting optional network work.
  constructSiteFlow(project, { routes: [], warnings: [] }, surface);
  const discovery = await discoverFlowRoutes({
    directory,
    readyUrl: project.server.readyUrl,
    exclude: project.coverage?.exclude ?? [],
    open: () => openFlowBrowser(project),
  });
  return constructSiteFlow(project, discovery, surface);
};
