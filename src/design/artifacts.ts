import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { PNG } from "pngjs";
import { observationArtifactSchema } from "../checks/artifact-schema.js";
import type { CheckTuple, ObservationArtifact } from "../checks/types.js";
import { compareDesignImage } from "./image-diff.js";
import { matchElements } from "./match.js";
import {
  type CapturedDesign,
  type DesignDescriptor,
  designDescriptorSchema,
  designRegionsSchema,
  type LoadedDesign,
  matchesSchema,
} from "./types.js";

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
export async function writeDesignArtifacts(options: {
  runDirectory: string;
  base: string;
  design: CapturedDesign;
  coordinate: DesignDescriptor["coordinate"];
  app?: ObservationArtifact | undefined;
  /** The app tuple's screenshot; image references are compared against it. */
  appScreenshot?: Buffer | undefined;
  /** `design/<name>/` when a tuple carries several references. */
  subdirectory?: string | undefined;
}): Promise<DesignDescriptor> {
  const { design } = options,
    base = `${options.base.split(sep).join("/")}/design${options.subdirectory ? `/${options.subdirectory}` : ""}`;
  const image = design.resolved?.kind === "image" ? design.image : undefined;
  const figma = design.figma !== undefined;
  const artifacts: DesignDescriptor["artifacts"] =
    design.resolved?.kind === "image"
      ? {
          screenshot: `${base}/screenshot.png`,
          console: `${base}/console.jsonl`,
          source: `${base}/source.json`,
          image: `${base}/reference.${image?.extension ?? "png"}`,
          regions: `${base}/regions.json`,
        }
      : {
          observations: `${base}/observations.json`,
          screenshot: `${base}/screenshot.png`,
          ...(figma
            ? { figma: `${base}/figma.json` }
            : {
                dom: `${base}/dom.html`,
                console: `${base}/console.jsonl`,
                axe: `${base}/axe.json`,
              }),
          source: `${base}/source.json`,
          matches: `${base}/matches.json`,
        };
  const result = design.result;
  let failure = design.failure;
  let regions: string | undefined;
  if (image && result?.ok && result.screenshot && !failure) {
    if (!options.appScreenshot)
      failure =
        "The app screenshot is unavailable, so the design image cannot be compared";
    else
      try {
        regions = json(
          compareDesignImage({
            design: PNG.sync.read(result.screenshot),
            app: PNG.sync.read(options.appScreenshot),
            width: options.coordinate.width,
            observations: options.app,
          }),
        );
      } catch (error) {
        failure = `Design image comparison failed: ${error instanceof Error ? error.message : String(error)}`;
      }
  }
  const descriptor: DesignDescriptor = {
    version: 1,
    source: design.source,
    ...(design.name === undefined ? {} : { name: design.name }),
    resolved: design.resolved,
    ...(design.figma === undefined ? {} : { figma: design.figma }),
    coordinate: options.coordinate,
    runtimeVersion: design.runtimeVersion,
    status:
      !failure &&
      result?.ok === true &&
      result.screenshot &&
      (image ? regions !== undefined : result.observations?.version === 2)
        ? "captured"
        : "failed",
    ...(failure ? { failure } : {}),
    artifacts,
  };
  if (descriptor.status === "failed" && !descriptor.failure)
    descriptor.failure = "Design reference evidence is incomplete";
  await mkdir(join(options.runDirectory, base), { recursive: true });
  if (image && artifacts.image)
    await writeFile(join(options.runDirectory, artifacts.image), image.bytes);
  if (regions !== undefined && artifacts.regions)
    await writeFile(join(options.runDirectory, artifacts.regions), regions);
  if (result) {
    if (result.observations && artifacts.observations)
      await writeFile(
        join(options.runDirectory, artifacts.observations),
        json(result.observations),
      );
    if (result.screenshot)
      await writeFile(
        join(options.runDirectory, artifacts.screenshot),
        result.screenshot,
      );
    if (artifacts.dom && result.ok && result.dom !== undefined)
      await writeFile(join(options.runDirectory, artifacts.dom), result.dom);
    if (artifacts.axe && result.ok && result.axe !== undefined)
      await writeFile(
        join(options.runDirectory, artifacts.axe),
        json(result.axe),
      );
    if (artifacts.console)
      await writeFile(
        join(options.runDirectory, artifacts.console),
        result.console.map((record) => JSON.stringify(record)).join("\n"),
      );
    if (artifacts.figma && design.figmaDocument !== undefined)
      await writeFile(
        join(options.runDirectory, artifacts.figma),
        json(design.figmaDocument),
      );
    if (
      artifacts.matches &&
      result.observations?.version === 2 &&
      options.app?.version === 2
    )
      await writeFile(
        join(options.runDirectory, artifacts.matches),
        json(matchElements(result.observations, options.app)),
      );
  }
  await writeFile(
    join(options.runDirectory, artifacts.source),
    json(descriptor),
  );
  return descriptor;
}
export async function loadDesignArtifacts(
  runDirectory: string,
  raw: unknown,
  tuple: CheckTuple,
): Promise<LoadedDesign> {
  const descriptor = designDescriptorSchema.parse(raw),
    loaded: LoadedDesign = { descriptor };
  try {
    const coordinate = descriptor.coordinate;
    if (
      coordinate.state !== tuple.state ||
      coordinate.viewport !== tuple.viewport ||
      coordinate.width !== tuple.width ||
      coordinate.height !== tuple.height ||
      coordinate.colorScheme !== (tuple.colorScheme ?? "light")
    )
      throw new Error("design coordinate disagrees with app tuple");
    const base = `${relative(
      runDirectory,
      resolve(runDirectory, tuple.metadataPath, ".."),
    )
      .split(sep)
      .join("/")}/design/`;
    const root = await realpath(runDirectory);
    const missing: string[] = [];
    for (const path of Object.values(descriptor.artifacts)) {
      if (path === undefined) continue;
      if (!path.startsWith(base))
        throw new Error("design artifact is outside its owning tuple");
      let physical: string;
      try {
        physical = await realpath(resolve(runDirectory, path));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        missing.push(path);
        continue;
      }
      const rel = relative(root, physical);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
        throw new Error("design artifact escapes run directory");
      tuple.artifactPaths.push(path);
    }
    if (descriptor.status === "captured" && missing.length)
      throw new Error(
        `missing design artifacts: ${missing.join(", ")}; recapture`,
      );
    if (descriptor.status !== "captured")
      throw new Error(descriptor.failure ?? "design capture failed");
    const { artifacts } = descriptor;
    const read = (path: string) => readFile(join(runDirectory, path));
    const source = designDescriptorSchema.parse(
      JSON.parse((await read(artifacts.source)).toString("utf8")),
    );
    if (JSON.stringify(source) !== JSON.stringify(descriptor))
      throw new Error("design source descriptor disagrees with metadata");
    if (descriptor.resolved?.kind === "image") {
      if (!artifacts.image || !artifacts.regions)
        throw new Error("image design artifacts are incomplete");
      if (
        createHash("sha256")
          .update(await read(artifacts.image))
          .digest("hex") !== descriptor.resolved.sha256
      )
        throw new Error("saved design image disagrees with its recorded hash");
      if (!tuple.screenshotPath)
        throw new Error("the app screenshot is unavailable");
      const regions = designRegionsSchema.parse(
        JSON.parse((await read(artifacts.regions)).toString("utf8")),
      );
      const recomputed = designRegionsSchema.parse(
        JSON.parse(
          JSON.stringify(
            compareDesignImage({
              design: PNG.sync.read(await read(artifacts.screenshot)),
              app: PNG.sync.read(await read(tuple.screenshotPath)),
              width: tuple.width,
              observations: tuple.observations,
            }),
          ),
        ),
      );
      if (JSON.stringify(regions) !== JSON.stringify(recomputed))
        throw new Error(
          "saved design regions disagree with screenshots; recapture",
        );
      loaded.screenshotPath = artifacts.screenshot;
      loaded.regions = regions;
      return loaded;
    }
    if (!artifacts.observations || !artifacts.matches)
      throw new Error("design element artifacts are incomplete");
    const obs = observationArtifactSchema.parse(
      JSON.parse(
        await readFile(join(runDirectory, artifacts.observations), "utf8"),
      ),
    );
    if (
      obs.viewport.width !== tuple.width ||
      obs.viewport.height !== tuple.height
    )
      throw new Error("design observation viewport disagrees with app tuple");
    loaded.observations = obs;
    loaded.screenshotPath = descriptor.artifacts.screenshot;
    const matches = matchesSchema.parse(
      JSON.parse(await readFile(join(runDirectory, artifacts.matches), "utf8")),
    );
    if (
      obs.version !== 2 ||
      tuple.observations?.version !== 2 ||
      JSON.stringify(matches) !==
        JSON.stringify(
          matchesSchema.parse(matchElements(obs, tuple.observations)),
        )
    )
      throw new Error(
        "saved design matches disagree with observation evidence",
      );
    loaded.matches = matches;
  } catch (error) {
    loaded.unavailable =
      descriptor.status === "failed"
        ? (descriptor.failure ?? "Design capture failed")
        : `Design evidence unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
  return loaded;
}
