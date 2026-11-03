function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether `value` appears in `text` as a whole token, so `finding-1` never
 * matches inside `finding-12`. Used to scope a malformed tracker ticket's
 * blast radius to the lineages its raw text names.
 */
export function mentionsToken(text: string, value: string): boolean {
  if (value.length === 0) return false;
  return new RegExp(
    `(?<![A-Za-z0-9_-])${escapeRegExp(value)}(?![A-Za-z0-9_-])`,
  ).test(text);
}
