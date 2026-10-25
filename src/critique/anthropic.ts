import { readFile } from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";
import {
  MAX_REFERENCE_ENCODED_BYTES,
  referenceImageLimitIssue,
} from "../references/limits.js";
import type { DecisionObservation } from "../schemas/ruling.js";
import { critiquePrompt } from "./prompt.js";
import { MalformedCritiqueError, parseModelResponse } from "./schema.js";
import type {
  CritiqueAdapter,
  CritiqueInput,
  CritiqueResult,
  CropRef,
  ModelFindingCandidate,
  ReferenceRef,
  ScreenshotRef,
} from "./types.js";
import { critiqueResult } from "./types.js";

type ImageBlock = {
  type: "image";
  source: {
    type: "base64";
    media_type: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
    data: string;
  };
};
type TextBlock = { type: "text"; text: string };
type Message = {
  role: "user" | "assistant";
  content: string | Array<ImageBlock | TextBlock>;
};
export type AnthropicRequest = {
  model: string;
  max_tokens: number;
  messages: Message[];
};
export type MessageClient = {
  messages: {
    create(request: AnthropicRequest): Promise<unknown>;
  };
};

const MAX_IMAGES = 20;
const MAX_ENCODED_BATCH_BYTES = 20 * 1024 * 1024;
const MAX_TOKENS = 16_000;

type LoadedImage = {
  label: string;
  screenshot?: ScreenshotRef;
  crop?: CropRef;
  reference?: Extract<ReferenceRef, { kind: "image" }>;
  block: ImageBlock;
  encodedBytes: number;
};

function responseText(response: unknown): string {
  if (response === null || typeof response !== "object") return "";
  const content = (response as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        block !== null &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("");
}

function sanitized(error: unknown): string {
  const source = error instanceof Error ? error.message : String(error);
  return source
    .replace(
      /(?:sk-ant-|api[_ -]?key(?!\s+is\s+not\s+set\b)[=: ]+)[A-Za-z0-9._-]+/gi,
      "[redacted]",
    )
    .replace(/\s+/g, " ")
    .slice(0, 500);
}

export class AnthropicCritiqueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnthropicCritiqueError";
  }
}

export function requireAnthropicApiKey(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const apiKey = environment.ANTHROPIC_API_KEY;
  if (apiKey === undefined || apiKey.trim() === "") {
    throw new AnthropicCritiqueError("ANTHROPIC_API_KEY is not set");
  }
  return apiKey;
}

function assertImageBudget(
  source: Buffer,
  mediaType: ImageBlock["source"]["media_type"],
  label: string,
): void {
  const issue = referenceImageLimitIssue(source, mediaType);
  if (issue !== undefined)
    throw new AnthropicCritiqueError(
      `image ${JSON.stringify(label)} exceeds the model request budget: ${issue}`,
    );
}

async function loadImages(input: CritiqueInput): Promise<LoadedImage[]> {
  const loaded: LoadedImage[] = [];
  for (const screenshot of input.screenshots) {
    const source = await readFile(screenshot.readPath);
    assertImageBudget(source, "image/png", screenshot.label);
    const data = source.toString("base64");
    loaded.push({
      label: screenshot.label,
      screenshot,
      encodedBytes: Buffer.byteLength(data),
      block: {
        type: "image",
        source: { type: "base64", media_type: "image/png", data },
      },
    });
  }
  for (const crop of input.crops ?? []) {
    const source = await readFile(crop.readPath);
    assertImageBudget(source, "image/png", crop.label);
    const data = source.toString("base64");
    loaded.push({
      label: crop.label,
      crop,
      encodedBytes: Buffer.byteLength(data),
      block: {
        type: "image",
        source: { type: "base64", media_type: "image/png", data },
      },
    });
  }
  for (const reference of input.references) {
    if (reference.kind !== "image") continue;
    const source = await readFile(reference.readPath);
    assertImageBudget(source, reference.mediaType, reference.label);
    const data = source.toString("base64");
    loaded.push({
      label: reference.label,
      reference,
      encodedBytes: Buffer.byteLength(data),
      block: {
        type: "image",
        source: { type: "base64", media_type: reference.mediaType, data },
      },
    });
  }
  return loaded;
}

function batches(images: LoadedImage[]): LoadedImage[][] {
  const anchor = images.find((image) => image.screenshot !== undefined);
  if (anchor === undefined) return [];
  // A state's screenshots and its zoomed crops travel together, so the model
  // sees each magnified region beside the capture it comes from.
  const stateOf = (image: LoadedImage) =>
    (image.screenshot ?? image.crop)?.state;
  const screenshotUnits: LoadedImage[][] = [];
  for (const image of images.filter(
    (candidate) =>
      candidate.screenshot !== undefined || candidate.crop !== undefined,
  )) {
    const previous =
      image.crop === undefined
        ? screenshotUnits.at(-1)
        : [...screenshotUnits]
            .reverse()
            .find(
              (unit) =>
                unit[0] !== undefined && stateOf(unit[0]) === stateOf(image),
            );
    if (previous?.[0] !== undefined && stateOf(previous[0]) === stateOf(image))
      previous.push(image);
    else screenshotUnits.push([image]);
  }
  const units = [
    ...screenshotUnits.flatMap((unit) => {
      const encodedBytes = unit.reduce(
        (total, image) => total + image.encodedBytes,
        0,
      );
      return unit.length <= MAX_IMAGES &&
        encodedBytes <= MAX_ENCODED_BATCH_BYTES
        ? [unit]
        : unit.map((image) => [image]);
    }),
    ...images
      .filter((image) => image.reference !== undefined)
      .map((image) => [image]),
  ];
  const groups: LoadedImage[][] = [];
  let current: LoadedImage[] = [];
  let bytes = 0;
  const finish = () => {
    if (current.length === 0) return;
    if (!current.some((image) => image.screenshot !== undefined)) {
      current.unshift(anchor);
      bytes += anchor.encodedBytes;
    }
    groups.push(current);
    current = [];
    bytes = 0;
  };
  for (const unit of units) {
    const unitBytes = unit.reduce(
      (total, image) => total + image.encodedBytes,
      0,
    );
    if (
      unit.some((image) => image.encodedBytes > MAX_REFERENCE_ENCODED_BYTES) ||
      unitBytes > MAX_ENCODED_BATCH_BYTES
    ) {
      throw new AnthropicCritiqueError(
        `image ${JSON.stringify(unit[0]?.label)} exceeds the model request budget`,
      );
    }
    const willHaveScreenshot =
      current.some((image) => image.screenshot !== undefined) ||
      unit.some((image) => image.screenshot !== undefined);
    const reservedCount = willHaveScreenshot ? 0 : 1;
    const reservedBytes = willHaveScreenshot ? 0 : anchor.encodedBytes;
    if (
      current.length > 0 &&
      (current.length + unit.length + reservedCount > MAX_IMAGES ||
        bytes + unitBytes + reservedBytes > MAX_ENCODED_BATCH_BYTES)
    ) {
      finish();
    }
    const emptyReservedCount = unit.some(
      (image) => image.screenshot !== undefined,
    )
      ? 0
      : 1;
    const emptyReservedBytes =
      emptyReservedCount === 0 ? 0 : anchor.encodedBytes;
    if (
      current.length === 0 &&
      (unit.length + emptyReservedCount > MAX_IMAGES ||
        unitBytes + emptyReservedBytes > MAX_ENCODED_BATCH_BYTES)
    ) {
      throw new AnthropicCritiqueError(
        `image ${JSON.stringify(unit[0]?.label)} cannot share a model batch with captured evidence`,
      );
    }
    current.push(...unit);
    bytes += unitBytes;
  }
  finish();
  return groups;
}

function request(
  model: string,
  content: Array<ImageBlock | TextBlock>,
  extraMessages: Message[] = [],
): AnthropicRequest {
  return {
    model,
    max_tokens: MAX_TOKENS,
    messages: [{ role: "user", content }, ...extraMessages],
  };
}

export class AnthropicCritiqueAdapter implements CritiqueAdapter {
  readonly model: string;
  readonly client: MessageClient;

  constructor(options: {
    model: string;
    client?: MessageClient | undefined;
    environment?: NodeJS.ProcessEnv | undefined;
  }) {
    this.model = options.model;
    if (options.client !== undefined) {
      this.client = options.client;
      return;
    }
    const apiKey = requireAnthropicApiKey(options.environment);
    this.client = new Anthropic({ apiKey }) as unknown as MessageClient;
  }

  async critique(input: CritiqueInput): Promise<CritiqueResult> {
    const allImages = await loadImages(input);
    if (
      allImages.filter((image) => image.screenshot !== undefined).length === 0
    )
      return critiqueResult({ findings: [] });
    const output: ModelFindingCandidate[] = [];
    const observations: DecisionObservation[] = [];
    let discardedDecisionObservations = 0;
    for (const batch of batches(allImages)) {
      const screenshotRefs = batch.flatMap((image) =>
        image.screenshot === undefined ? [] : [image.screenshot],
      );
      const referenceRefs = batch.flatMap((image) =>
        image.reference === undefined ? [] : [image.reference],
      );
      const cropRefs = batch.flatMap((image) =>
        image.crop === undefined ? [] : [image.crop],
      );
      const availableReferences = [
        ...referenceRefs,
        ...input.references.filter((reference) => reference.kind === "text"),
      ];
      if (screenshotRefs.length === 0) continue;
      const content: Array<ImageBlock | TextBlock> = [
        ...batch.flatMap((image, index) => [
          {
            type: "text" as const,
            text: `Image ${index + 1} — ${image.label}`,
          },
          image.block,
        ]),
        {
          type: "text",
          text: critiquePrompt(input, screenshotRefs, referenceRefs, cropRefs),
        },
      ];
      let raw: string;
      try {
        raw = responseText(
          await this.client.messages.create(request(this.model, content)),
        );
      } catch (error) {
        throw new AnthropicCritiqueError(
          `Anthropic model ${JSON.stringify(this.model)} failed: ${sanitized(error)}`,
        );
      }
      try {
        const parsed = parseModelResponse(
          raw,
          screenshotRefs,
          availableReferences,
          input.screenshots,
          input.designMd,
          input.spec !== undefined,
          input.page,
        );
        output.push(...parsed.findings);
        observations.push(...parsed.decisionObservations);
        discardedDecisionObservations += parsed.discardedDecisionObservations;
      } catch (error) {
        if (!(error instanceof MalformedCritiqueError)) throw error;
        let repaired: string;
        const repairInstruction = `Return a corrected JSON object only. Validation issues: ${error.issues.join("; ")}`;
        try {
          const repairRequest =
            raw.trim() === ""
              ? request(this.model, [
                  ...content,
                  { type: "text", text: repairInstruction },
                ])
              : request(this.model, content, [
                  { role: "assistant", content: raw },
                  { role: "user", content: repairInstruction },
                ]);
          repaired = responseText(
            await this.client.messages.create(repairRequest),
          );
        } catch (repairError) {
          throw new AnthropicCritiqueError(
            `Anthropic model ${JSON.stringify(this.model)} repair failed: ${sanitized(repairError)}`,
          );
        }
        const parsed = parseModelResponse(
          repaired,
          screenshotRefs,
          availableReferences,
          input.screenshots,
          input.designMd,
          input.spec !== undefined,
          input.page,
        );
        output.push(...parsed.findings);
        observations.push(...parsed.decisionObservations);
        discardedDecisionObservations += parsed.discardedDecisionObservations;
      }
    }
    return critiqueResult({
      findings: output,
      decisionObservations: observations,
      discardedDecisionObservations,
    });
  }
}
