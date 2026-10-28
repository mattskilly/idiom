import { expect, test } from "vitest";
import { analyticsRequest } from "../src/capture/request-policy.js";

const request = (url: string, resourceType = "fetch") => ({
  url: () => url,
  resourceType: () => resourceType,
});

test.each([
  "https://www.google-analytics.com/g/collect?v=2",
  "https://region1.analytics.google.com/g/collect",
  "https://www.googletagmanager.com/gtag/js?id=G-1",
  "https://stats.g.doubleclick.net/j/collect",
  "https://api.segment.io/v1/t",
  "https://cdn.segment.com/analytics.js/v1/x/analytics.min.js",
  "https://api-js.mixpanel.com/track/",
  "https://api2.amplitude.com/2/httpapi",
  "https://plausible.io/api/event",
  "https://us.i.posthog.com/e/",
  "https://k.clarity.ms/collect",
  "https://bat.bing.com/action/0",
  "https://www.facebook.com/tr/",
  "https://o123.ingest.sentry.io/api/1/envelope/",
  "https://o123.ingest.us.sentry.io/api/1/envelope/",
  "https://browser-intake-datadoghq.com/api/v2/rum",
  "https://browser-intake-us5-datadoghq.com/api/v2/rum",
  "https://rs.fullstory.com/rec/bundle",
  "https://in.hotjar.com/api/v2/client",
  "https://content.hotjar.io/x",
  "https://heapanalytics.com/h",
  "https://static.cloudflareinsights.com/beacon.min.js",
  "https://app.example.com/_vercel/insights/view",
  "https://app.example.com/_vercel/speed-insights/vitals",
])("%s is analytics", (url) => {
  expect(analyticsRequest(request(url))).toBe(true);
});

test("a beacon is analytics by resource type", () => {
  expect(
    analyticsRequest(request("https://app.example.com/save", "ping")),
  ).toBe(true);
});

test.each([
  "https://app.example.com/api/items",
  "https://example.com/tr",
  "https://plausible.io/docs",
  "https://notgoogle-analytics.com.example.com/x",
  "https://api.example.com/_vercel/other",
  "https://www.facebook.com/profile",
  "not a url",
])("%s is not analytics", (url) => {
  expect(analyticsRequest(request(url))).toBe(false);
});
