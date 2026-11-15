import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { type Browser, chromium, type Page } from "playwright";
import { expect, test } from "vitest";
import { probeControls } from "../src/capture/probe.js";
import { duplicateEntryCheck } from "../src/checks/duplicate-entry.js";
import { observePage } from "../src/checks/observe.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import { stateJumpCheck } from "../src/checks/state-jump.js";
import type {
  CheckTuple,
  ObservationArtifact,
  ObservationArtifactV2,
} from "../src/checks/types.js";
// @ts-expect-error Fixture server is authored Node ESM.
import { fieldAppServer, ROUTES } from "./fixtures/field-app/server.mjs";
import { invariantTuple } from "./invariant-support.js";
import {
  type FixtureServer,
  spawnFixtureServer,
} from "./support/fixture-server.js";

const root = join(import.meta.dirname, "fixtures");
const record = join(import.meta.dirname, "../docs/field-test/state-jump.json");
const config = checksConfigFrom();
const MAX_TRIGGERS = 8;

type Candidate = { rule: string; selector: string; explanation: string };
type Entry = {
  source: string;
  route: string;
  width: number;
  height: number;
  scheme: "light" | "dark";
  /** "rest" for the probe pass, otherwise the trigger clicked. */
  trigger: string;
  capture: string;
  candidates: Candidate[];
  reviewed: string;
};

/**
 * Reviewed candidates the sweep is allowed to produce, by
 * `source route trigger → selector` at every width and scheme. Each is a
 * true positive whose reason is recorded in the committed sweep record.
 */
const BUSY =
  "the clicked button changes width while its request is pending (its label becomes a busy label or gains a spinner), so the control itself jumps; the spec includes the trigger";
const PUSH =
  "content inserted or removed above these sections moves them as one group between the linked states; reported as specified (an element present in both states moved), and a flow declares it in intendedChanges when the push is intended";
const TAB =
  "switching the tab changes how many rows the table shows, so the sections below move as one group; reported as specified, and declared in intendedChanges when intended";
const reviewedTruePositives: Record<string, string> = {
  "field-app /orders Refunds → #detail-title": TAB,
  "field-app /orders Pending → #detail-title": TAB,
  "field-app /orders Show details → button.button.button--orders-details": BUSY,
  "field-app /orders Check carrier updates → #older-title": PUSH,
  "field-app /orders Older orders → body > main > section:nth-of-type(5) > h2":
    PUSH,
  "field-app /customers Show segments → #tickets-title": PUSH,
  "field-app /customers Calculate lifetime value → body > main > section:nth-of-type(5) > h2":
    PUSH,
  "field-app /customers Save tag → button.button.button--customers-tag.button--primary":
    BUSY,
  "field-app /settings Save profile → button.button.button--primary.button--settings-profile":
    BUSY,
  "field-app /settings Update password → button.button.button--primary.button--settings-password":
    BUSY,
  "field-app /settings Save preferences → button.button.button--primary.button--settings-preferences":
    BUSY,
  "field-app /billing Update card → button.button.button--billing-card.button--primary":
    BUSY,
  "field-app /billing Add seat → button.button.button--billing-seat.button--primary":
    BUSY,
  "field-app /team Invite again → button.button.button--primary.button--team-reinvite":
    BUSY,
  "field-app /team Save role → button.button.button--primary.button--team-role":
    BUSY,
  "field-app /activity Load audit events → #sync-title": PUSH,
  "field-app /activity Check sync status → #webhooks-title": PUSH,
  "field-app /activity Load webhook deliveries → #deploys-title": PUSH,
  "field-app /activity Load deploy log → #keys-title": PUSH,
};

async function freePort() {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("port");
  await new Promise<void>((r) => server.close(() => r()));
  return address.port;
}

const key = (
  entry: Pick<Entry, "source" | "route" | "trigger">,
  selector: string,
) => `${entry.source} ${entry.route} ${entry.trigger} → ${selector}`;

function tupleOf(
  state: string,
  observations: ObservationArtifact,
  width: number,
  height: number,
  scheme: "light" | "dark",
  extra: Partial<CheckTuple> = {},
): CheckTuple {
  return {
    ...invariantTuple(observations as ObservationArtifactV2),
    state,
    width,
    height,
    colorScheme: scheme,
    ...extra,
  };
}

/** Visible disclosure triggers, as selectors the page resolves uniquely. */
async function disclosureTriggers(page: Page): Promise<string[]> {
  return page.evaluate((max) => {
    const found: string[] = [];
    let index = 0;
    for (const element of document.querySelectorAll(
      "[aria-expanded], [aria-haspopup]",
    )) {
      if (found.length >= max) break;
      if (!element.checkVisibility({ checkOpacity: true })) continue;
      const box = element.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) continue;
      index += 1;
      element.setAttribute("data-sweep-trigger", String(index));
      found.push(`[data-sweep-trigger="${index}"]`);
    }
    return found;
  }, MAX_TRIGGERS);
}

// Opt-in record update (IDIOM_UPDATE_STATE_JUMP_SWEEP=1) keeps ordinary runs
// read-only. Every pair is a real at-rest observation and a real observation
// after clicking a disclosure or field-test trigger on a fresh load.
test("state-jump and navigation entry-point precision sweep over the gate and field apps", {
  timeout: 900000,
}, async () => {
  let browser: Browser | undefined;
  let gate: FixtureServer | undefined;
  let field: { url: string; close(): Promise<void> } | undefined;
  const entries: Entry[] = [];
  const cases = (
    JSON.parse(await readFile(join(root, "field-app/cases.json"), "utf8")) as {
      cases: Array<{ route: string; trigger: string }>;
    }
  ).cases;
  const push = (entry: Omit<Entry, "reviewed">) => {
    const reasons = entry.candidates.map(
      (c) => reviewedTruePositives[key(entry, c.selector)],
    );
    entries.push({
      ...entry,
      reviewed:
        entry.capture !== "ok"
          ? "capture failure is not a precision pass"
          : entry.candidates.length === 0
            ? "no false positives"
            : reasons.every((r) => r !== undefined)
              ? `true positive: ${[...new Set(reasons)].join("; ")}`
              : "review required",
    });
  };
  const sweepRoute = async (
    source: string,
    base: string,
    route: string,
    viewport: { width: number; height: number },
    scheme: "light" | "dark",
  ) => {
    if (!browser) throw Error("browser");
    const coordinate = {
      source,
      route,
      width: viewport.width,
      height: viewport.height,
      scheme,
    };
    const open = async () => {
      if (!browser) throw Error("browser");
      const page = await browser.newPage({
        viewport,
        colorScheme: scheme,
        reducedMotion: "reduce",
      });
      await page.goto(`${base}${route}`, { waitUntil: "load" });
      await page.waitForTimeout(200);
      return page;
    };
    const rest = await open();
    let restTuple: CheckTuple;
    let triggers: string[];
    try {
      triggers = await disclosureTriggers(rest);
      restTuple = tupleOf(
        "rest",
        await observePage(rest, { status: "not-configured" }),
        viewport.width,
        viewport.height,
        scheme,
      );
    } finally {
      await rest.close();
    }
    const named = cases
      .filter((item) => source === "field-app" && item.route === route)
      .map((item) => item.trigger);
    const clicks: Array<{ label: string; selector?: string; name?: string }> = [
      ...triggers.map((selector) => ({ label: selector, selector })),
      ...named.map((name) => ({ label: name, name })),
    ].slice(0, MAX_TRIGGERS);
    for (const click of clicks) {
      const page = await open();
      try {
        const before = page.url();
        if (click.selector !== undefined) await disclosureTriggers(page);
        const name = click.name ?? "";
        const target =
          click.selector !== undefined
            ? page.locator(click.selector)
            : (["button", "link", "tab", "menuitem", "switch"] as const)
                .map((role) => page.getByRole(role, { name, exact: true }))
                .reduce((all, next) => all.or(next))
                .first();
        await target.click({ timeout: 2000 });
        await page.waitForTimeout(500);
        if (page.url() !== before) {
          push({
            ...coordinate,
            trigger: click.label,
            capture: "ok",
            candidates: [],
          });
          continue;
        }
        const after = tupleOf(
          "opened",
          await observePage(page, { status: "not-configured" }),
          viewport.width,
          viewport.height,
          scheme,
          { from: "rest" },
        );
        const result = stateJumpCheck.run({
          tuple: after,
          tuples: [restTuple, after],
          narrowViewport: false,
          config,
        });
        push({
          ...coordinate,
          trigger: click.label,
          capture:
            result.coverage.status === "ran"
              ? "ok"
              : `${result.coverage.status}: ${result.coverage.reason ?? ""}`,
          candidates: result.candidates.map((c) => ({
            rule: c.rule,
            selector: c.selectorHint,
            explanation: c.explanation,
          })),
        });
      } catch (error) {
        push({
          ...coordinate,
          trigger: click.label,
          capture:
            error instanceof Error
              ? (error.message.split("\n")[0] ?? "")
              : String(error),
          candidates: [],
        });
      } finally {
        await page.close();
      }
    }
    // The probe pass for navigation entry points: desktop, light, once.
    if (viewport.width < 1000 || scheme !== "light") return;
    const page = await open();
    try {
      const url = `${base}${route}`;
      const observations = await observePage(page, {
        status: "not-configured",
      });
      const probe = await probeControls({
        page,
        skip: [],
        maxControls: 30,
        waitMs: 150,
        stateTimeoutMs: 60_000,
        restore: async (active) => {
          await active.goto(url);
        },
      });
      if (observations.version !== 2) throw Error("missing V2");
      const tuple = tupleOf(
        "rest",
        { ...observations, probe },
        viewport.width,
        viewport.height,
        scheme,
        { documentUrl: url },
      );
      const result = duplicateEntryCheck.run({
        tuple,
        tuples: [tuple],
        narrowViewport: false,
        config,
      });
      push({
        ...coordinate,
        trigger: "probe",
        capture: "ok",
        candidates: result.candidates
          .filter((c) => c.fingerprintHint?.includes("|navigate|"))
          .map((c) => ({
            rule: c.rule,
            selector: c.selectorHint,
            explanation: c.explanation,
          })),
      });
    } catch (error) {
      push({
        ...coordinate,
        trigger: "probe",
        capture:
          error instanceof Error
            ? (error.message.split("\n")[0] ?? "")
            : String(error),
        candidates: [],
      });
    } finally {
      await page.close();
    }
  };
  try {
    browser = await chromium.launch();
    const port = await freePort();
    const gateUrl = `http://127.0.0.1:${port}`;
    gate = await spawnFixtureServer(join(root, "gate-app/server.mjs"), {
      env: { PORT: String(port) },
      readyUrl: `${gateUrl}/ready`,
    });
    const gateFlow = JSON.parse(
      await readFile(join(root, "gate-app/.idiom/flows/app.json"), "utf8"),
    );
    const gateProject = JSON.parse(
      await readFile(join(root, "gate-app/.idiom/project.json"), "utf8"),
    );
    for (const state of gateFlow.states)
      for (const viewport of gateProject.viewports)
        for (const scheme of gateProject.colorSchemes)
          await sweepRoute("gate-app", gateUrl, state.url, viewport, scheme);
    field = await fieldAppServer();
    const fieldUrl = field?.url;
    if (!fieldUrl) throw Error("field server");
    for (const route of ROUTES as string[])
      for (const viewport of gateProject.viewports)
        for (const scheme of gateProject.colorSchemes)
          await sweepRoute("field-app", fieldUrl, route, viewport, scheme);
  } finally {
    await field?.close();
    await gate?.stop();
    await browser?.close();
    if (process.env.IDIOM_UPDATE_STATE_JUMP_SWEEP === "1")
      await writeFile(
        record,
        `${JSON.stringify(
          {
            description:
              "Every gate-app state and field-app route at desktop and mobile, light and dark: an at-rest observation paired with an observation after clicking each visible disclosure trigger and each field-test trigger on that route (at most 8, each on a fresh load; a click that navigates is recorded without a comparison), through state-jump; plus one probe per route at desktop light through the navigation pass of duplicate-entry. Severities stay minor regardless of the result.",
            review: {
              pairs: entries.filter((e) => e.trigger !== "probe").length,
              probes: entries.filter((e) => e.trigger === "probe").length,
              captureFailures: entries.filter((e) => e.capture !== "ok").length,
              candidates: entries.reduce(
                (sum, e) => sum + e.candidates.length,
                0,
              ),
              truePositives: entries.filter((e) =>
                e.reviewed.startsWith("true positive:"),
              ).length,
            },
            entries,
          },
          null,
          2,
        )}\n`,
      );
  }
  expect(entries.filter((e) => e.capture !== "ok")).toEqual([]);
  expect(
    entries.flatMap((e) =>
      e.candidates
        .map((c) => key(e, c.selector))
        .filter((k) => reviewedTruePositives[k] === undefined),
    ),
  ).toEqual([]);
});
