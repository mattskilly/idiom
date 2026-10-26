import { createHash } from "node:crypto";

function legacyNormalizeSelectorHint(value: string): string {
  return value
    .trim()
    .replace(/(?:\.[A-Za-z_][A-Za-z0-9_-]*){2,}/g, (classes) =>
      classes
        .split(".")
        .filter(Boolean)
        .sort()
        .map((name) => `.${name}`)
        .join(""),
    )
    .replace(/\s+/g, " ");
}

export function generatedClass(value: string): boolean {
  return (
    /__[A-Za-z0-9_-]{5,}$/.test(value) ||
    /^(?:css|jsx|sc|emotion|styled)[-_][A-Za-z0-9_-]{5,}$/i.test(value) ||
    /^[a-f0-9]{8,}$/i.test(value)
  );
}

export function normalizeSelectorHint(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .replace(/\s*([>+~])\s*/g, " $1 ")
    .replace(/\s*\|\s*/g, " | ");
  return normalized
    .split(" | ")
    .map((part) => {
      // Observation and model semantic hints can include URLs or state paths;
      // those are not CSS and their punctuation is identity-bearing.
      if (part.includes("://") || part.includes("/")) return part;
      return part.replace(
        /(?:\.[A-Za-z_][A-Za-z0-9_-]*)+/g,
        (classes, offset: number) => {
          const stable = classes
            .slice(1)
            .split(".")
            .filter((name) => !generatedClass(name))
            .sort();
          if (stable.length > 0)
            return stable.map((name) => `.${name}`).join("");

          const before = part.slice(0, offset);
          const after = part.slice(offset + classes.length);
          const compoundStart = Math.max(
            before.lastIndexOf(" "),
            before.lastIndexOf(">"),
            before.lastIndexOf("+"),
            before.lastIndexOf("~"),
          );
          const followingSeparator = after.search(/[\s>+~]/);
          const compoundEnd =
            followingSeparator < 0
              ? part.length
              : offset + classes.length + followingSeparator;
          const remainder = `${part.slice(compoundStart + 1, offset)}${part.slice(
            offset + classes.length,
            compoundEnd,
          )}`;
          const hasStableAnchor =
            /^(?:[A-Za-z][A-Za-z0-9_-]*|\*)/.test(remainder) ||
            /#[A-Za-z_][A-Za-z0-9_-]*/.test(remainder) ||
            /\[[^\]]+\]/.test(remainder) ||
            /\.[A-Za-z_][A-Za-z0-9_-]*/.test(remainder);

          // A generated-only compound has no structural identity to fall
          // back to. Retaining its token is safer than collapsing unrelated
          // elements into the same permanent decision-memory key.
          return hasStableAnchor ? "" : classes;
        },
      );
    })
    .join(" | ");
}

export type FingerprintInput = {
  category: string;
  flow: string;
  state: string;
  rule: string;
  selectorHint: string;
  colorScheme?: "light" | "dark" | undefined;
  legacyColorScheme?: "light" | "dark" | undefined;
};

function hashFingerprint(
  input: FingerprintInput,
  selectorHint: string,
): string {
  return createHash("sha256")
    .update(
      [
        input.category,
        input.flow,
        input.state,
        ...(input.colorScheme === undefined ? [] : [input.colorScheme]),
        input.rule,
        selectorHint,
      ].join(" | "),
    )
    .digest("hex");
}

export function findingFingerprint(input: FingerprintInput): string {
  return hashFingerprint(input, normalizeSelectorHint(input.selectorHint));
}

export function findingFingerprintIdentity(input: FingerprintInput): {
  fingerprint: string;
  aliases: string[];
} {
  const fingerprint = findingFingerprint(input);
  const legacy = hashFingerprint(
    input,
    legacyNormalizeSelectorHint(input.selectorHint),
  );
  const aliases = new Set<string>();
  if (legacy !== fingerprint) aliases.add(legacy);
  if (
    input.colorScheme !== undefined &&
    input.colorScheme === input.legacyColorScheme
  ) {
    const schemeLess = { ...input, colorScheme: undefined };
    aliases.add(findingFingerprint(schemeLess));
    aliases.add(
      hashFingerprint(
        schemeLess,
        legacyNormalizeSelectorHint(input.selectorHint),
      ),
    );
  }
  aliases.delete(fingerprint);
  return {
    fingerprint,
    aliases: [...aliases],
  };
}

/**
 * The same element and rule wherever it repeats: the fingerprint inputs minus
 * state and colour scheme (the viewport is already absent from both).
 */
export function findingGroupKey(input: {
  category: string;
  flow: string;
  rule: string;
  selectorHint: string;
}): string {
  return createHash("sha256")
    .update(
      [
        "idiom-group-v1",
        input.category,
        input.flow,
        input.rule,
        normalizeSelectorHint(input.selectorHint),
      ].join(" | "),
    )
    .digest("hex");
}
