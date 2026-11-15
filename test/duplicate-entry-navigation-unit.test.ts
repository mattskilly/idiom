import { describe, expect, test } from "vitest";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import {
  duplicateEntryCheck,
  navigationKey,
} from "../src/checks/duplicate-entry.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import type {
  CheckTuple,
  ObservedElementV2,
  ProbeArtifact,
  ProbePalette,
  ProbeResult,
} from "../src/checks/types.js";
import { invariantObservations, invariantTuple } from "./invariant-support.js";
import { signalElement } from "./signal-element-support.js";

const page = "https://app.test/projects/7?tab=overview";

function link(selector: string, name: string, href: string): ObservedElementV2 {
  return signalElement(selector, {
    tag: "a",
    interactive: true,
    rect: { x: 0, y: 0, width: 80, height: 24 },
    signals: { role: "link", name, href },
  });
}

const projectMenu = (
  items: Array<{ name: string; href?: string; disabled?: boolean }>,
): ProbeResult => ({
  selector: "#project",
  name: "Project",
  effects: ["dom"],
  persistent: true,
  signature: "open:menu:Project",
  menu: {
    trigger: { x: 0, y: 0, width: 80, height: 28 },
    group: "html > body > header",
    root: "#project-menu",
    items: items.map((item, index) => ({
      name: item.name,
      disabled: item.disabled ?? false,
      selector: `#project-menu > a:nth-of-type(${index + 1})`,
      ...(item.href === undefined ? {} : { href: item.href }),
    })),
  },
});

function tuple(
  elements: ObservedElementV2[],
  results: ProbeResult[],
  extra: Partial<ProbeArtifact> = {},
  documentUrl: string | null = page,
): CheckTuple {
  return {
    ...invariantTuple({
      ...invariantObservations(),
      elements,
      probe: { status: "ran", results, ...extra },
    }),
    ...(documentUrl === null ? {} : { documentUrl }),
  };
}

const run = (target: CheckTuple, navigation?: "pathname" | "query" | "full") =>
  duplicateEntryCheck.run({
    tuple: target,
    tuples: [target],
    narrowViewport: false,
    config: checksConfigFrom(
      navigation === undefined ? {} : { duplicateEntry: { navigation } },
    ),
  });

const navigationFindings = (target: CheckTuple, match?: "query" | "full") =>
  run(target, match).candidates.filter((candidate) =>
    candidate.fingerprintHint?.includes("|navigate|"),
  );

const sideNav = [
  link("#nav-leads", "Leads", "/leads"),
  link("#nav-reports", "Reports", "/reports/"),
];

describe("navigationKey", () => {
  test("pathname, query and full keys; trailing slashes normalise", () => {
    const url = new URL("https://app.test/leads/?b=2&a=1#top");
    expect(navigationKey(url, "pathname")).toBe("/leads");
    expect(navigationKey(url, "query")).toBe("/leads?a=1&b=2");
    expect(navigationKey(url, "full")).toBe("/leads?a=1&b=2#top");
    expect(navigationKey(new URL("https://app.test/"), "pathname")).toBe("/");
  });
});

describe("navigation entry points", () => {
  test("a menu item duplicating a side-nav route fires, ignoring the query", () => {
    const findings = navigationFindings(
      tuple(sideNav, [
        projectMenu([
          { name: "Leads", href: "https://app.test/leads?tab=all" },
        ]),
      ]),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      rule: "idiom:redundant-entry-point",
      severity: "minor",
      selectorHint: "#nav-leads",
      fingerprintHint: "idiom:redundant-entry-point|navigate|/leads",
    });
    expect(findings[0]?.explanation).toContain('in the "Project" menu');
    expect(findings[0]?.explanation).toContain('"Leads" (#nav-leads)');
  });

  test("query and full matching keep different queries apart", () => {
    const target = tuple(sideNav, [
      projectMenu([{ name: "Leads", href: "https://app.test/leads?tab=all" }]),
    ]);
    expect(navigationFindings(target, "query")).toEqual([]);
    const same = tuple(sideNav, [
      projectMenu([{ name: "Reports", href: "https://app.test/reports" }]),
    ]);
    expect(navigationFindings(same, "full")).toHaveLength(1);
  });

  test("a menu item to a different route does not fire", () => {
    expect(
      navigationFindings(
        tuple(sideNav, [
          projectMenu([{ name: "Billing", href: "https://app.test/billing" }]),
        ]),
      ),
    ).toEqual([]);
  });

  test("two persistent links to one route never fire on their own", () => {
    expect(
      navigationFindings(
        tuple(
          [
            link("#logo", "Home", "/"),
            link("#header-home", "Home", "/"),
            link("#footer-home", "Back to top", "/"),
          ],
          [],
        ),
      ),
    ).toEqual([]);
  });

  test("in-page anchors, cross-origin links and disabled rows are ignored", () => {
    const target = tuple(
      [
        link("#jump", "Overview", "#overview"),
        link("#docs", "Docs", "https://docs.test/leads"),
      ],
      [
        projectMenu([
          { name: "Overview", href: `${page}#overview` },
          { name: "Docs", href: "https://app.test/leads" },
          {
            name: "Docs again",
            href: "https://app.test/leads",
            disabled: true,
          },
        ]),
      ],
    );
    expect(navigationFindings(target)).toEqual([]);
  });

  test("a clicked menu item that navigates joins its inventory row as one entry", () => {
    const clicked: ProbeResult = {
      selector: "#project-menu > a:nth-of-type(1) span",
      name: "Project › Leads",
      effects: ["navigation"],
      persistent: false,
      signature: "navigate:/leads",
      destination: "https://app.test/leads",
    };
    const findings = navigationFindings(
      tuple(sideNav, [
        projectMenu([{ name: "Leads", href: "https://app.test/leads" }]),
        clicked,
      ]),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.verification.params?.members).toHaveLength(2);
  });

  test("older results without destination still group by signature pathname", () => {
    const legacy: ProbeResult = {
      selector: "#menu-leads",
      name: "Project › Leads",
      effects: ["navigation"],
      persistent: false,
      signature: "navigate:/leads/",
    };
    expect(navigationFindings(tuple(sideNav, [legacy]))).toHaveLength(1);
  });

  test("repeated and skipped results are excluded", () => {
    const base: ProbeResult = {
      selector: "#menu-leads",
      name: "Project › Leads",
      effects: ["navigation"],
      persistent: false,
      signature: "navigate:/leads",
    };
    expect(
      navigationFindings(
        tuple(sideNav, [
          { ...base, repeated: true },
          { ...base, selector: "#other", skipped: "timed-out" },
          {
            ...projectMenu([{ name: "Leads", href: "https://app.test/leads" }]),
            repeated: true,
          },
        ]),
      ),
    ).toEqual([]);
  });

  test("page links need a document URL; the gap is disclosed", () => {
    const target = tuple(
      sideNav,
      [projectMenu([{ name: "Leads", href: "https://app.test/leads" }])],
      {},
      null,
    );
    const result = run(target);
    expect(result.candidates).toEqual([]);
    expect(result.coverage.reason).toContain("no document URL");
  });
});

describe("command palette entries", () => {
  const palette = (
    entries: ProbePalette["entries"],
    status: ProbePalette["status"] = "opened",
  ): Partial<ProbeArtifact> => ({
    palette: { shortcut: "Meta+K", status, entries, root: "#palette" },
  });

  test("a palette link and an exact-name script entry join their routes", () => {
    const findings = navigationFindings(
      tuple(
        [...sideNav, link("#nav-settings", "Settings", "/settings")],
        [],
        palette([
          { name: "Leads", selector: "#p1", href: "https://app.test/leads" },
          { name: "settings", selector: "#p2" },
          { name: "Invite", selector: "#p3" },
        ]),
      ),
    );
    expect(findings.map((finding) => finding.fingerprintHint).sort()).toEqual([
      "idiom:redundant-entry-point|navigate|/leads",
      "idiom:redundant-entry-point|navigate|/settings",
    ]);
    expect(findings[0]?.explanation).toContain(
      "in the command palette (Meta+K)",
    );
  });

  test("an ambiguous name does not join", () => {
    expect(
      navigationFindings(
        tuple(
          [
            link("#a", "Settings", "/settings"),
            link("#b", "Settings", "/account/settings"),
          ],
          [],
          palette([{ name: "Settings", selector: "#p2" }]),
        ),
      ),
    ).toEqual([]);
  });

  test("a palette that did not open is a coverage note, not a finding", () => {
    const result = run(tuple(sideNav, [], palette([], "nothing-opened")));
    expect(result.candidates).toEqual([]);
    expect(result.coverage).toMatchObject({
      status: "ran",
      reason: expect.stringContaining(
        "command palette (Meta+K) nothing-opened",
      ),
    });
  });

  test("palette, destination and menu hrefs parse in the artifact schema", () => {
    const target = tuple(
      sideNav,
      [
        {
          ...projectMenu([{ name: "Leads", href: "https://app.test/leads" }]),
          destination: "https://app.test/leads",
        },
      ],
      palette([
        { name: "Leads", selector: "#p1", href: "https://app.test/leads" },
      ]),
    );
    expect(
      observationArtifactSchema.safeParse(target.observations).success,
    ).toBe(true);
  });
});
