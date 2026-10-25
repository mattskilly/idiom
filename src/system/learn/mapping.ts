import type { TokenKind } from "./schema.js";
/** Purpose is an explicit naming inference, separate from the DTCG value type. */
export function dimensionKind(name: string): TokenKind {
  const words = name.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
  if (
    /(?:control|button|input)[._-]?height|height[._-](?:control|button|input)/.test(
      words,
    )
  )
    return "control-height";
  if (/(?:^|[._-])(?:radius|radii)(?:$|[._-])/.test(words)) return "radius";
  if (/(?:^|[._-])(?:spacing|space|gap|padding|margin)(?:$|[._-])/.test(words))
    return "spacing";
  return "other";
}
