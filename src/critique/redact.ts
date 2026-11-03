/** The missing-configuration diagnostic the credential pattern must leave readable. */
export const MISSING_ANTHROPIC_API_KEY_MESSAGE = "ANTHROPIC_API_KEY is not set";

// The `(?!\s+is\s+not\s+set\b)` lookahead keeps MISSING_ANTHROPIC_API_KEY_MESSAGE
// (and the provider fallback clause that starts with it) readable. Change the
// message and this exception together.
const CREDENTIAL_PATTERN =
  /sk-ant-[A-Za-z0-9._~+/-]+|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|(?:api[_ -]?key(?!\s+is\s+not\s+set\b)|access[_ -]?token|authorization|bearer)(?:[=: ]+)(?:bearer[ ]+)?[A-Za-z0-9._~+/-]+/gi;

/** The single credential-redaction policy for model-review diagnostics. */
export function redactCredentials(text: string): string {
  return text.replace(CREDENTIAL_PATTERN, "[redacted]");
}
