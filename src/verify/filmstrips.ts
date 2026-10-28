import { cp, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { evidencePath } from "../artifact-path.js";
import type { FilmstripRequest } from "../capture/types.js";
import {
  actionIdentity,
  sameAction,
  temporalAction,
} from "../checks/temporal-evidence.js";
import type { CheckTuple } from "../checks/types.js";
import { pngDataUri } from "../report/html.js";
import { composeFilmstrip } from "../review/filmstrips.js";
import type { Finding } from "../schemas/finding.js";
import type { AttachmentManifest } from "./attachments.js";

function tupleFor(tuples: CheckTuple[], finding: Finding) {
  return tuples.find(
    (t) =>
      t.state === finding.state &&
      t.viewport === finding.viewport &&
      (finding.colorScheme === undefined ||
        t.colorScheme === finding.colorScheme),
  );
}
export function verificationFilmstripRequests(
  findings: Finding[],
  tuples: CheckTuple[],
): FilmstripRequest[] {
  return findings.flatMap((finding) => {
    const tuple = tupleFor(tuples, finding);
    if (!tuple) return [];
    const action = temporalAction(tuple, {
      ...finding,
      timeline: finding.evidence.timeline?.id,
    });
    if (!action) return [];
    return [
      {
        state: tuple.state,
        viewport: tuple.viewport,
        colorScheme: tuple.colorScheme,
        identity: actionIdentity(action),
        offsetsMs: tuple.filmstrips?.offsetsMs ?? [0, 50, 100, 200, 400, 800],
      },
    ];
  });
}
export async function verificationFilmstrips(options: {
  findings: Finding[];
  baseline: { runDirectory: string; tuples: CheckTuple[] };
  after: { runDirectory: string; tuples: CheckTuple[] };
  output: string;
  manifest: AttachmentManifest;
}): Promise<Map<string, string>> {
  const images = new Map<string, string>();
  const collection: NonNullable<AttachmentManifest["filmstrips"]> = [];
  for (const finding of options.findings) {
    const tuple = tupleFor(options.baseline.tuples, finding);
    const action =
      tuple &&
      temporalAction(tuple, {
        ...finding,
        timeline: finding.evidence.timeline?.id,
      });
    const temporal =
      !!finding.evidence.timeline ||
      finding.category === "motion" ||
      finding.category === "layout-shift" ||
      finding.category === "loading-state-missing" ||
      finding.category === "double-submit" ||
      finding.category === "error-state-missing" ||
      finding.category === "retry-blocked";
    if (!temporal) continue;
    const ordinal = collection.length + 1;
    const item: NonNullable<AttachmentManifest["filmstrips"]>[number] = {
      ordinal,
      kind: `idiom-filmstrip-${String(ordinal).padStart(3, "0")}`,
      finding: finding.id,
      state: finding.state,
      viewport: finding.viewport,
      ...(finding.colorScheme === undefined
        ? {}
        : { colorScheme: finding.colorScheme }),
      frames: [],
    };
    const historical = tuple?.filmstrips?.actions.find(
      (a) => a.id === action?.id,
    );
    const afterTuple = tupleFor(options.after.tuples, finding);
    const matches =
      afterTuple?.timelines?.actions.filter(
        (a) => action && sameAction(actionIdentity(a), actionIdentity(action)),
      ) ?? [];
    const current =
      matches.length === 1
        ? afterTuple?.filmstrips?.actions.find((a) => a.id === matches[0]?.id)
        : undefined;
    const regions = [historical?.region, current?.region].filter(
      (r): r is NonNullable<typeof r> => r !== undefined,
    );
    const left = Math.min(...regions.map((r) => r.x));
    const top = Math.min(...regions.map((r) => r.y));
    const commonRegion = regions.length
      ? {
          x: left,
          y: top,
          width: Math.max(...regions.map((r) => r.x + r.width)) - left,
          height: Math.max(...regions.map((r) => r.y + r.height)) - top,
        }
      : undefined;
    for (const side of ["before", "after"] as const) {
      const source = side === "before" ? options.baseline : options.after;
      const selectedTuple = side === "before" ? tuple : afterTuple;
      const selectedAction = side === "before" ? action : matches[0];
      const selectedFilm = side === "before" ? historical : current;
      const missingKey =
        side === "before" ? "beforeUnavailable" : "afterUnavailable";
      if (
        !selectedTuple ||
        !selectedAction ||
        !selectedFilm ||
        (side === "after" && matches.length !== 1)
      ) {
        item[missingKey] =
          side === "after" && matches.length > 1
            ? "action identity is ambiguous after the change"
            : `${side} action pixels unavailable`;
        continue;
      }
      const folder = `filmstrips/${String(ordinal).padStart(3, "0")}/${side}`;
      const root = join(options.output, folder);
      await mkdir(root, { recursive: true });
      const base = dirname(selectedTuple.metadataPath);
      // Copy the selected original pixels before temporary recaptures are retired.
      for (const frame of selectedFilm.frames)
        if (frame.path) {
          const target = join(folder, frame.path);
          await mkdir(dirname(join(options.output, target)), {
            recursive: true,
          });
          await cp(
            await evidencePath(source.runDirectory, join(base, frame.path)),
            join(options.output, target),
          );
          item.frames?.push(target);
        }
      if (
        side === "before" &&
        finding.evidence.filmstrip?.sheet &&
        JSON.stringify(commonRegion) !== JSON.stringify(selectedFilm.region)
      ) {
        const original = `${folder}/historical-sheet.png`;
        await cp(
          await evidencePath(
            source.runDirectory,
            finding.evidence.filmstrip.sheet,
          ),
          join(options.output, original),
        );
        item.frames?.push(original);
      }
      const localTuple = { ...selectedTuple, metadataPath: "metadata.json" };
      const sheetPath = `${folder}/sheet.png`;
      if (
        side === "before" &&
        finding.evidence.filmstrip?.sheet &&
        JSON.stringify(commonRegion) === JSON.stringify(selectedFilm.region)
      ) {
        await cp(
          await evidencePath(
            source.runDirectory,
            finding.evidence.filmstrip.sheet,
          ),
          join(options.output, sheetPath),
        );
        item.before = sheetPath;
      } else {
        const sheet = await composeFilmstrip({
          runDirectory: root,
          tuple: localTuple,
          action: selectedFilm,
          timeline: selectedAction,
          selector: String(
            finding.verification.params?.surface ??
              finding.verification.params?.selector ??
              "",
          ),
          path: "sheet.png",
          region: commonRegion,
        });
        if (sheet.sheet) item[side] = sheetPath;
        else item[missingKey] = sheet.reason ?? "sheet unavailable";
      }
      if (item[side])
        images.set(
          item[side],
          pngDataUri(await readFile(join(options.output, item[side]))),
        );
    }
    collection.push(item);
  }
  if (collection.length) options.manifest.filmstrips = collection;
  return images;
}
