export type FailureCode =
  | "disabled"
  | "invalid-input"
  | "blocked-url"
  | "bot"
  | "rate-limit"
  | "cap-reached"
  | "unavailable"
  | "timeout"
  | "report-too-large"
  | "failed"
  | "gone";

const messages: Record<FailureCode, string> = {
  disabled: "Hosted review is not enabled.",
  "invalid-input":
    "Enter a public HTTP(S) URL and, optionally, one PNG, JPEG, WebP or reference URL.",
  "blocked-url":
    "This URL or its resolved destination is not a public HTTP(S) page.",
  bot: "We could not verify this request. Please try again in your browser.",
  "rate-limit":
    "Three reviews per IP per UTC day are allowed. Try again tomorrow.",
  "cap-reached":
    "The hosted review budget has been reached. Run locally: npm install -g @mattskilly/idiom",
  unavailable:
    "Hosted review is temporarily unavailable. Run locally: npm install -g @mattskilly/idiom",
  timeout:
    "The review exceeded its 90-second limit. No complete report was published.",
  "report-too-large":
    "The evidence exceeds the hosted report size limit. Run this review locally.",
  failed: "The page could not be reviewed. No complete report was published.",
  gone: "This report is unavailable, expired or deleted.",
};
export class HostedError extends Error {
  constructor(
    public readonly code: FailureCode,
    public readonly field?: string,
  ) {
    super(messages[code]);
  }
}
export function failure(error: unknown) {
  const known =
    error instanceof HostedError ? error : new HostedError("failed");
  return {
    type: "error" as const,
    code: known.code,
    message: known.message,
    ...(known.field ? { field: known.field } : {}),
  };
}
export function statusFor(code: FailureCode): number {
  return {
    disabled: 404,
    "invalid-input": 400,
    "blocked-url": 400,
    bot: 403,
    "rate-limit": 429,
    "cap-reached": 503,
    unavailable: 503,
    timeout: 504,
    "report-too-large": 422,
    failed: 502,
    gone: 404,
  }[code];
}
