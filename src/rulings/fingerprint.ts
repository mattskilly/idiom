import { createHash } from "node:crypto";

export function normalizeChoiceKey(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/gu, " ");
}

export function rulingFingerprint(choiceKey: string): string {
  return createHash("sha256")
    .update(`idiom-ruling-v1\0${normalizeChoiceKey(choiceKey)}`)
    .digest("hex");
}
