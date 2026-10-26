import type {
  BrowserSession,
  CaptureHooks,
  FlowState,
  SelectedViewport,
  TupleResult,
} from "../capture/types.js";
import { type DesignLocation, designSourceLabel } from "../schemas/design.js";
import { flowSchema } from "../schemas/flow.js";
import type { ColorScheme, Project } from "../schemas/project.js";
import {
  captureFigmaDesign,
  type FigmaCaptureOptions,
  figmaFrameLoader,
  frameWidth,
} from "./figma/capture.js";
import { designReferences, selectDesignViewport } from "./references.js";
import { resolveDesignSource } from "./source.js";
import type { CapturedDesign } from "./types.js";

export type DesignLoader = ReturnType<typeof figmaFrameLoader>;
export type { FigmaCaptureOptions };
export { figmaFrameLoader };

/**
 * Capture every design reference that applies to one tuple. A Figma frame
 * applies at the viewport nearest its width (or the declared one) and in the
 * declared colour scheme; HTML references apply everywhere unless they
 * declare a viewport or scheme.
 */
export async function captureDesigns(
  options: CaptureHooks & {
    state: FlowState;
    directory: string;
    project: Project;
    viewport: SelectedViewport;
    colorScheme: ColorScheme;
    browser: () => Promise<BrowserSession>;
    figma: DesignLoader;
  },
): Promise<{ designs?: CapturedDesign[]; notApplicable?: string }> {
  const designs: CapturedDesign[] = [],
    skipped: string[] = [];
  for (const ref of designReferences(options.state)) {
    const figmaSource =
      ref.figma && typeof ref.source === "string" ? ref.source : undefined;
    const scheme =
      ref.colorScheme ??
      (ref.figma ? options.project.capture.colorScheme : undefined);
    if (scheme !== undefined && scheme !== options.colorScheme) {
      skipped.push(`design reference ${ref.name} applies in ${scheme} scheme`);
      continue;
    }
    let selected = ref.viewport;
    if (figmaSource !== undefined && selected === undefined)
      try {
        selected = selectDesignViewport(
          ref,
          frameWidth(await options.figma(figmaSource)),
          options.project.viewports,
        );
      } catch {
        // Unknown width: apply everywhere so the fetch failure is reported.
      }
    if (selected !== undefined && selected !== options.viewport.name) {
      skipped.push(
        `design reference ${ref.name} applies at viewport ${selected}`,
      );
      continue;
    }
    const design = figmaSource
      ? await captureFigmaDesign({
          source: figmaSource,
          name: ref.name,
          frame: options.figma(figmaSource),
          projectDirectory: options.directory,
          viewport: options.viewport,
        })
      : await captureDesign({
          ...options,
          source: ref.source,
          appState: options.state,
          browser: await options.browser(),
        });
    designs.push({ ...design, name: ref.name });
  }
  return designs.length
    ? { designs }
    : skipped.length
      ? { notApplicable: skipped.join("; ") }
      : {};
}

export async function captureDesign(
  options: CaptureHooks & {
    source: DesignLocation;
    /** The app state; a live-site reference settles like it. */
    appState?: { settleMs?: number | undefined } | undefined;
    directory: string;
    project: Project;
    viewport: SelectedViewport;
    colorScheme: ColorScheme;
    browser: BrowserSession;
  },
): Promise<CapturedDesign> {
  let source: Awaited<ReturnType<typeof resolveDesignSource>> | undefined;
  const label = designSourceLabel(options.source);
  try {
    options.signal?.throwIfAborted();
    options.onActivity?.("design reference");
    source = await resolveDesignSource(
      options.source,
      options.directory,
      options.signal,
    );
    const kind = source.provenance.kind;
    const settleMs =
      kind === "site"
        ? (options.appState?.settleMs ?? options.project.capture.settleMs)
        : undefined;
    const state = flowSchema.parse({
      id: "design-reference",
      title: "Design reference",
      intent: [],
      setup: [],
      states: [
        {
          id: "design",
          description:
            kind === "image"
              ? "Intended design image"
              : kind === "site"
                ? "Reference site"
                : "Intended HTML design",
          url: source.url,
          ...(settleMs === undefined ? {} : { settleMs }),
          expect: {},
        },
      ],
      viewports: [options.viewport.name],
    }).states[0];
    if (!state) throw new Error("Cannot create design capture state");
    const result: TupleResult = await options.browser.capture({
      // An image is captured whole: as tall as it scales to the viewport width.
      project:
        kind === "image"
          ? {
              ...options.project,
              capture: { ...options.project.capture, fullPage: true },
            }
          : options.project,
      state,
      viewport: options.viewport,
      colorScheme: options.colorScheme,
      navigationUrl: source.url,
      designReference: source,
      signal: options.signal,
      onActivity: options.onActivity,
      probe: false,
    });
    return {
      source: label,
      resolved: source.provenance,
      ...(source.image ? { image: source.image } : {}),
      runtimeVersion: options.browser.version,
      result,
      ...(!result.ok
        ? { failure: result.message }
        : result.mismatches.length
          ? { failure: "Design reference expectation failed" }
          : {}),
    };
  } catch (error) {
    options.signal?.throwIfAborted();
    return {
      source: label,
      resolved: source?.provenance,
      runtimeVersion: options.browser.version,
      failure: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await source?.close();
  }
}
