import { copyFile, mkdir, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { beneath, evidencePath, readJson } from "./common.mjs";

/** All artifact destinations are generated, never derived from untrusted names. */
export async function stageImage(root, source, evidence, path, label) {
  const input = await evidencePath(root, source);
  const output = beneath(evidence, path);
  await mkdir(dirname(output), { recursive: true });
  await evidencePath(evidence, dirname(output));
  await copyFile(input, output);
  return { path, label };
}

export async function stageFinding(
  finding,
  capture,
  evidence,
  namespace,
  ordinal,
  stored = [],
) {
  const entry = { images: [], reasons: [] };
  if (finding.timeline) {
    const original = stored.find(
      (item) =>
        item.id === finding.id &&
        (!finding.fingerprint || item.fingerprint === finding.fingerprint),
    );
    const filmstrip = original?.evidence?.filmstrip;
    if (filmstrip) {
      if (filmstrip.status !== "complete")
        entry.reasons.push(
          `Filmstrip ${filmstrip.status}: ${filmstrip.reason ?? "reason unavailable"}`,
        );
    } else
      entry.reasons.push(
        "Filmstrip completeness unknown (stored finding metadata unavailable).",
      );
    if (finding.filmstrip) {
      try {
        entry.images.push(
          await stageImage(
            capture.runDirectory,
            resolve(capture.project, finding.filmstrip),
            evidence,
            `filmstrips/${namespace}/${ordinal}.png`,
            "Filmstrip contact sheet",
          ),
        );
        return entry;
      } catch (error) {
        entry.reasons.push(`Filmstrip unavailable: ${error.message}`);
      }
    } else
      entry.reasons.push(
        "Filmstrip unavailable: no contact sheet for this timeline.",
      );
  }
  if (finding.screenshot || finding.evidence) {
    try {
      const source = resolve(
        capture.project,
        finding.screenshot ?? finding.evidence,
      );
      const label = source.includes("/crops/")
        ? "Element crop"
        : "Full screenshot (element crop unavailable)";
      entry.images.push(
        await stageImage(
          capture.runDirectory,
          source,
          evidence,
          `crops/${namespace}/${ordinal}.png`,
          finding.timeline ? `Static fallback — ${label}` : label,
        ),
      );
    } catch (error) {
      entry.reasons.push(`Screenshot unavailable: ${error.message}`);
    }
  } else entry.reasons.push("Screenshot unavailable: no image recorded.");
  return entry;
}

export async function storedFindings(capture) {
  try {
    return await readJson(
      await evidencePath(capture.runDirectory, "findings.json"),
    );
  } catch {
    return [];
  }
}

export async function stageCurrent(result, capture, evidence) {
  result.evidence = {};
  const stored = await storedFindings(capture);
  for (const [index, finding] of result.summary.findings.entries()) {
    const entry = await stageFinding(
      finding,
      capture,
      evidence,
      "current",
      index + 1,
      stored,
    );
    result.evidence[`finding:${index}`] = entry;
    result.crops.push(
      ...entry.images.map((image) => ({ ...image, finding: index })),
    );
  }
  for (const [p, pattern] of (
    result.summary.advisory?.patterns ?? []
  ).entries())
    for (const [i, finding] of pattern.findings.entries())
      result.evidence[`advisory:${p}:${i}`] = await stageFinding(
        finding,
        capture,
        evidence,
        `advisory-${p}`,
        i + 1,
      );
  let questions, questionError;
  if (result.summary.designSystemQuestions?.length) {
    try {
      questions = await readJson(
        await evidencePath(capture.runDirectory, "unruled-decisions.json"),
      );
    } catch (error) {
      questionError = error.message;
    }
  }
  for (const [index, question] of (
    result.summary.designSystemQuestions ?? []
  ).entries()) {
    const entry = { images: [], reasons: [] };
    const examples =
      questions?.find((item) => item.id === question.id)?.scaleCluster
        ?.examples ?? [];
    for (const [i, example] of examples.slice(0, 3).entries()) {
      try {
        // Question example paths are run-relative, unlike SummaryFinding paths.
        entry.images.push(
          await stageImage(
            capture.runDirectory,
            example.crop ?? example.screenshot,
            evidence,
            `crops/questions/${index + 1}-${i + 1}.png`,
            example.crop
              ? `Question example ${i + 1} crop`
              : `Question example ${i + 1} full screenshot (crop unavailable)`,
          ),
        );
      } catch (error) {
        entry.reasons.push(
          `Question example ${i + 1} unavailable: ${error.message}`,
        );
      }
    }
    if (!examples.length)
      entry.reasons.push(
        `Question examples unavailable: ${questionError ?? "no matching examples recorded"}`,
      );
    result.evidence[`question:${index}`] = entry;
  }
}

export async function stageComparison(
  result,
  comparison,
  directory,
  evidence,
  origin,
) {
  for (const [index, tuple] of comparison.changed.entries()) {
    try {
      const image = await stageImage(
        directory,
        tuple.path,
        evidence,
        `compare/${origin}/${index + 1}.png`,
        "Before / after composite",
      );
      result.composites.push({ ...image, key: tuple.key, origin });
    } catch (error) {
      result.unavailable.push(
        `Composite ${origin} ${tuple.key}: ${error.message}`,
      );
    }
  }
  for (const name of ["before-after.md", "attachments.json"]) {
    const output = beneath(evidence, `compare/${origin}/${name}`);
    await mkdir(dirname(output), { recursive: true });
    await evidencePath(evidence, dirname(output));
    await copyFile(await evidencePath(directory, name), output);
  }
}

/** Discover exact stored coordinates, including explicit scheme axes and combinations. */
export async function tupleImages(capture, flow, commit) {
  const tuples = new Map();
  async function visit(directory) {
    for (const item of await readdir(
      await evidencePath(capture.runDirectory, directory),
      { withFileTypes: true },
    )) {
      const path = join(directory, item.name);
      if (item.isDirectory()) await visit(path);
      else if (item.name === "metadata.json") {
        const record = await readJson(
          await evidencePath(capture.runDirectory, path),
        );
        if (record.flow?.id !== flow || record.source?.commit !== commit)
          throw new Error("tuple capture provenance mismatch");
        if (
          typeof record.state?.id !== "string" ||
          typeof record.viewport?.name !== "string" ||
          (record.colorSchemeAxis &&
            !["light", "dark"].includes(record.colorScheme))
        )
          throw new Error("invalid tuple coordinates");
        const key = `${record.state.id}/${record.viewport.name}${record.colorSchemeAxis ? `/${record.colorScheme}` : ""}${record.combination ? `#${record.combination.label}` : ""}`;
        const entry = {
          directory,
          failure: record.failure,
          screenshot: join(directory, "screenshot.png"),
        };
        // Never choose arbitrarily between metadata files with the same coordinate.
        tuples.set(
          key,
          tuples.has(key) ? { failure: "ambiguous tuple coordinates" } : entry,
        );
      }
    }
  }
  await visit(capture.runDirectory);
  return tuples;
}

export async function stageTuple(
  tuples,
  key,
  capture,
  evidence,
  namespace,
  ordinal,
) {
  const entry = { images: [], reasons: [] };
  const tuple = tuples.get(key);
  if (!tuple || tuple.failure) {
    entry.reasons.push(
      `Tuple screenshot unavailable: ${tuple?.failure ? JSON.stringify(tuple.failure) : `no exact tuple ${key}`}`,
    );
    return entry;
  }
  try {
    entry.images.push(
      await stageImage(
        capture.runDirectory,
        tuple.screenshot,
        evidence,
        `crops/${namespace}/${ordinal}.png`,
        "Settled tuple screenshot",
      ),
    );
  } catch (error) {
    entry.reasons.push(`Tuple screenshot unavailable: ${error.message}`);
  }
  return entry;
}
