// Environment policy for every Claude Code child that runs on subscription
// auth (critique, exploration, skill resolution). An inherited key, token,
// base URL, header, profile or third-party provider switch would otherwise
// move the run onto metered or proxied usage. See
// https://code.claude.com/docs/en/env-vars for the override variables.
//
// Removed: every `ANTHROPIC_*` variable (by prefix, so future overrides are
// covered too), the provider-selection flags below, `CLAUDE_CODE_SKIP_*_AUTH`
// and `AWS_BEARER_TOKEN_BEDROCK`. Everything else passes through unchanged,
// including PATH, HOME, keychain/XDG variables, `CLAUDE_CODE_OAUTH_*` and
// proxy/CA settings. Only the inherited process environment is covered; the
// user's Claude Code settings files are their own configuration.

/** Named variables removed alongside the `ANTHROPIC_` prefix and skip-auth flags. */
export const SUBSCRIPTION_AUTH_STRIPPED_PROVIDER_FLAGS: readonly string[] = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "AWS_BEARER_TOKEN_BEDROCK",
];

const SKIP_AUTH = /^CLAUDE_CODE_SKIP_[A-Z_]+_AUTH$/;

/** Case-insensitive, since Windows environment names keep the parent's casing. */
export function isSubscriptionAuthOverride(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    upper.startsWith("ANTHROPIC_") ||
    SUBSCRIPTION_AUTH_STRIPPED_PROVIDER_FLAGS.includes(upper) ||
    SKIP_AUTH.test(upper)
  );
}

/** A fresh copy of `environment` without any subscription-auth override. */
export function subscriptionAuthEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(environment)) {
    if (!isSubscriptionAuthOverride(name)) result[name] = value;
  }
  return result;
}
