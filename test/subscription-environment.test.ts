import { expect, test } from "vitest";
import {
  isSubscriptionAuthOverride,
  SUBSCRIPTION_AUTH_STRIPPED_PROVIDER_FLAGS,
  subscriptionAuthEnvironment,
} from "../src/critique/subscription-environment.js";

const overrides = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_PROFILE",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_ORGANIZATION_ID",
  "ANTHROPIC_WORKSPACE_ID",
  "ANTHROPIC_AWS_API_KEY",
  "ANTHROPIC_AWS_WORKSPACE_ID",
  "ANTHROPIC_AWS_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SOMETHING_NEW",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "CLAUDE_CODE_SKIP_VERTEX_AUTH",
  "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
  "CLAUDE_CODE_SKIP_MANTLE_AUTH",
  "CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH",
  "AWS_BEARER_TOKEN_BEDROCK",
  "anthropic_base_url",
  "Anthropic_Auth_Token",
  "claude_code_use_bedrock",
];

const preserved: NodeJS.ProcessEnv = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/example",
  USER: "example",
  CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
  CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "oauth-refresh",
  CLAUDE_CONFIG_DIR: "/home/example/.claude",
  HTTPS_PROXY: "http://proxy.corp.test:8080",
  NO_PROXY: "localhost",
  NODE_EXTRA_CA_CERTS: "/etc/ca.pem",
  CLAUDE_CODE_USE_POWERSHELL_TOOL: "1",
  CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1",
  AWS_REGION: "us-east-1",
};

test.each(overrides)("%s is removed from the child environment", (name) => {
  expect(isSubscriptionAuthOverride(name)).toBe(true);
  expect(
    subscriptionAuthEnvironment({ ...preserved, [name]: "inherited" }),
  ).toEqual(preserved);
});

test("every named provider flag is covered by the override test list", () => {
  for (const name of SUBSCRIPTION_AUTH_STRIPPED_PROVIDER_FLAGS)
    expect(overrides).toContain(name);
});

test("unrelated variables pass through with their exact values", () => {
  for (const name of Object.keys(preserved))
    expect(isSubscriptionAuthOverride(name)).toBe(false);
  expect(subscriptionAuthEnvironment(preserved)).toEqual(preserved);
});

test("returns a fresh object and leaves the input untouched", () => {
  const input: NodeJS.ProcessEnv = {
    PATH: "/usr/bin",
    ANTHROPIC_API_KEY: "sk-ant-inherited",
  };
  const result = subscriptionAuthEnvironment(input);
  expect(result).not.toBe(input);
  expect(result).toEqual({ PATH: "/usr/bin" });
  expect(input).toEqual({
    PATH: "/usr/bin",
    ANTHROPIC_API_KEY: "sk-ant-inherited",
  });
});
