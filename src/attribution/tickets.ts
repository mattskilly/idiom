/** Jira-style keys and local tracker ids; `attribution.ticketPattern` replaces it. */
export const DEFAULT_TICKET_PATTERN = "[A-Z]+-\\d+|file-\\d+";

/** Distinct ticket ids in a commit message, subject first, then body. */
export function ticketIds(message: string, pattern: string): string[] {
  const expression = new RegExp(pattern, "g");
  const found: string[] = [];
  for (const match of message.matchAll(expression)) {
    const id = match[0];
    if (id !== "" && !found.includes(id)) found.push(id);
  }
  return found;
}

/** Whether a configured pattern compiles. */
export function isValidPattern(pattern: string): boolean {
  try {
    new RegExp(pattern, "g");
    return true;
  } catch {
    return false;
  }
}
