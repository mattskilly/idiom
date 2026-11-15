import { describe, expect, test } from "vitest";
import { interpretObservation } from "../src/learn/interpret.js";
import {
  type CompiledLaw,
  compileLaw,
  lawConfigEdit,
  lawEditText,
  lawSummary,
} from "../src/learn/law.js";
import { checksConfigSchema } from "../src/schemas/project.js";

const law = (text: string): CompiledLaw => {
  const compiled = compileLaw(text);
  if (compiled === undefined || !("law" in compiled))
    throw new Error(`${text} did not compile: ${JSON.stringify(compiled)}`);
  return compiled.law;
};
const toolbar = { surface: "toolbar", selector: '[role="toolbar"]' };
const minimalProject = () => ({
  version: 1,
  baseUrl: "http://127.0.0.1:3000",
});

describe("min-gap", () => {
  test("the toolbar sentence compiles to control-gap at 4px scoped to the toolbar", () => {
    expect(
      law(
        "Nothing in a toolbar sits closer than 4px, glyph to glyph or glyph to button",
      ),
    ).toEqual({
      family: "min-gap",
      check: "control-gap",
      min: 4,
      scope: toolbar,
    });
  });
  test("close variants compile; a gap above the 12px scan ceiling does not", () => {
    expect(
      law("keep at least 6px between parts of a chip in the menu"),
    ).toEqual({
      family: "min-gap",
      check: "control-gap",
      min: 6,
      scope: { surface: "menu", selector: '[role="menu"], [role="menubar"]' },
    });
    expect(law("minimum gap of 3px between icon and label")).toMatchObject({
      min: 3,
    });
    expect(law("spacing of at least 2.5px in every dialog")).toMatchObject({
      min: 2.5,
      scope: { surface: "dialog" },
    });
    expect(compileLaw("keep at least 16px between parts of a chip")).toEqual({
      notCompiled:
        "control-gap measures gaps up to 12px, so a 16px minimum cannot be enforced",
    });
  });
  test("an unknown surface keeps its noun without a selector", () => {
    expect(law("nothing in the inspector sits closer than 4px")).toEqual({
      family: "min-gap",
      check: "control-gap",
      min: 4,
      scope: { surface: "inspector" },
    });
  });
});

describe("banned-css", () => {
  test("negative word-spacing on chrome text bans it on interface text", () => {
    expect(law("never use negative word-spacing on chrome text")).toEqual({
      family: "banned-css",
      check: "negative-spacing",
      property: "word-spacing",
      reach: "interface",
    });
  });
  test("anywhere and any text reach all text; both properties read as both", () => {
    expect(law("no negative tracking anywhere")).toMatchObject({
      property: "letter-spacing",
      reach: "all",
    });
    expect(law("no negative letter- or word-spacing on any text")).toEqual({
      family: "banned-css",
      check: "negative-spacing",
      property: "both",
      reach: "all",
    });
    expect(law("avoid negative letter-spacing in the toolbar")).toMatchObject({
      scope: toolbar,
    });
  });
  test("other banned CSS is not a measurable law", () => {
    expect(compileLaw("never use !important")).toBeUndefined();
    expect(compileLaw("letter-spacing should be generous")).toBeUndefined();
  });
});

describe("centring", () => {
  test("with and without a scope", () => {
    expect(law("labels in the toolbar are centred within 1px")).toEqual({
      family: "centring",
      check: "text-centering",
      tolerance: 1,
      scope: toolbar,
    });
    expect(law("button labels are centered within 2px")).toEqual({
      family: "centring",
      check: "text-centering",
      tolerance: 2,
    });
    expect(compileLaw("labels are centred within 0px")).toEqual({
      notCompiled: "a centring tolerance must be above 0px",
    });
  });
});

describe("share", () => {
  test("top edge and height, with and without a stated tolerance", () => {
    expect(law("items in a menu share a top edge within 1px")).toEqual({
      family: "share",
      check: "layout-invariants",
      share: "top",
      subject: "children",
      tolerance: 1,
      scope: { surface: "menu", selector: '[role="menu"], [role="menubar"]' },
    });
    expect(law("toolbar buttons share a height within 2px")).toEqual({
      family: "share",
      check: "layout-invariants",
      share: "height",
      subject: "buttons",
      tolerance: 2,
      scope: toolbar,
    });
    expect(law("controls in the toolbar share the same height")).toMatchObject({
      share: "height",
      tolerance: 1,
    });
  });
  test("an unscoped buttons law names the missing surface", () => {
    expect(compileLaw("buttons share a height")).toEqual({
      notCompiled:
        "name the surface the buttons share it in (toolbar, menu, field group…)",
    });
  });
  test("equal widths for fields, scoped and within forms", () => {
    expect(law("fields in a field group are equal widths")).toEqual({
      family: "share",
      check: "layout-invariants",
      share: "width",
      subject: "fields",
      tolerance: 1,
      scope: { surface: "field group", selector: 'fieldset, [role="group"]' },
    });
    expect(law("fields are the same width")).toMatchObject({
      subject: "fields",
      scope: { surface: "form", selector: "form" },
    });
  });
});

test("words that state no law compile to nothing and stay rulings", () => {
  for (const text of [
    "the button looks heavy",
    "the header feels cramped",
    "use the brand colour for links",
  ]) {
    expect(compileLaw(text)).toBeUndefined();
    expect(interpretObservation(text)).toEqual({ kind: "ruling" });
  }
});

test("compilation is deterministic", () => {
  const text =
    "Nothing in a toolbar sits closer than 4px, glyph to glyph or glyph to button";
  expect(compileLaw(text)).toEqual(compileLaw(text));
  expect(interpretObservation(text)).toEqual({
    kind: "law",
    law: law(text),
  });
});

test("summaries name the check and the scope", () => {
  expect(
    lawSummary(
      law(
        "Nothing in a toolbar sits closer than 4px, glyph to glyph or glyph to button",
      ),
    ),
  ).toBe(
    'Compiles to control-gap: parts inside a control keep at least 4px apart, scoped to the toolbar ([role="toolbar"]).',
  );
  expect(
    lawSummary(law("labels in the toolbar are centred within 1px")),
  ).toContain("Measured at the 1.5px font-metric floor.");
  expect(lawSummary(law("no negative tracking anywhere"))).toBe(
    "Compiles to negative-spacing: no negative letter-spacing on any painted text, everywhere.",
  );
});

describe("lawConfigEdit", () => {
  const apply = (
    text: string,
    value: Record<string, unknown> = minimalProject(),
  ) => {
    const compiled = law(text);
    const edit = lawConfigEdit(value, compiled, text, compiled.scope?.selector);
    expect(checksConfigSchema.safeParse(value.checks ?? {}).success).toBe(true);
    return { value, edit };
  };

  test("each family's configuration", () => {
    expect(
      apply("nothing in a toolbar sits closer than 6px").value.checks,
    ).toEqual({
      controlGap: {
        scopes: [
          {
            name: "nothing in a toolbar sits closer than 6px",
            selector: '[role="toolbar"]',
            min: 6,
          },
        ],
      },
    });
    expect(apply("never sit closer than 3px").value.checks).toEqual({
      controlGap: { min: 3 },
    });
    expect(apply("no negative tracking anywhere").value.checks).toEqual({
      negativeSpacing: { scope: "all" },
    });
    expect(
      apply("avoid negative letter-spacing in the toolbar").value.checks,
    ).toEqual({ negativeSpacing: { include: ['[role="toolbar"]'] } });
    expect(
      apply("labels in the toolbar are centred within 1px").value.checks,
    ).toEqual({
      textCentering: {
        scopes: [
          {
            name: "labels in the toolbar are centred within 1px",
            selector: '[role="toolbar"]',
            tolerance: 1,
          },
        ],
      },
    });
    expect(apply("labels are centered within 2px").value.checks).toEqual({
      centeringTolerance: 2,
    });
    const share = apply("toolbar buttons share a height within 2px");
    expect(share.value.checks).toEqual({
      invariants: [
        {
          name: "toolbar buttons share a height within 2px",
          optional: true,
          tolerance: 2,
          share: "height",
          selector: ':is([role="toolbar"]) :is(button, [role="button"])',
          within: '[role="toolbar"]',
        },
      ],
    });
    expect(share.edit).toMatchObject({
      check: "layout-invariants",
      scope: '[role="toolbar"]',
      edit: { kind: "append", path: ["checks", "invariants"] },
    });
    expect(
      apply("items in a menu share a top edge").value.checks,
    ).toMatchObject({
      invariants: [{ selector: ':is([role="menu"], [role="menubar"]) > *' }],
    });
  });

  test("a law the defaults already enforce changes nothing", () => {
    const value = minimalProject();
    expect(
      apply("never use negative word-spacing on chrome text", value).edit.edit,
    ).toBeUndefined();
    expect(
      apply("nothing sits closer than 4px", value).edit.edit,
    ).toBeUndefined();
    expect(value).toEqual(minimalProject());
  });

  test("a disabled check is enabled", () => {
    const value = {
      ...minimalProject(),
      checks: { negativeSpacing: { enabled: false } },
    };
    const { edit } = apply(
      "never use negative word-spacing on chrome text",
      value,
    );
    expect(value.checks.negativeSpacing).toEqual({ enabled: true });
    expect(edit.edit).toEqual({
      kind: "set",
      path: ["checks", "negativeSpacing"],
      value: { enabled: true },
    });
  });

  test("a second law for the same surface is refused, naming the existing entry", () => {
    const value = minimalProject();
    apply("nothing in a toolbar sits closer than 6px", value);
    expect(() =>
      apply("nothing in the toolbar sits closer than 5px", value),
    ).toThrow(
      'checks.controlGap.scopes already has [role="toolbar"] ("nothing in a toolbar sits closer than 6px"); edit it in .idiom/project.json',
    );
    apply("toolbar buttons share a height", value);
    expect(() =>
      apply("toolbar buttons share a height within 3px", value),
    ).toThrow(/checks\.invariants already has/);
  });

  test("an unknown surface needs a selector", () => {
    expect(() =>
      lawConfigEdit(
        minimalProject(),
        law("nothing in the inspector sits closer than 4px"),
        "x",
      ),
    ).toThrow(
      'no selector for "inspector"; pass --selector to compile the law',
    );
  });

  test("the file edit keeps the rest of the file as written", () => {
    const before = `{\n  "version": 1,\n  "baseUrl": "http://127.0.0.1:3000",\n  "checks": { "minGap": 3 }\n}\n`;
    const value = JSON.parse(before) as Record<string, unknown>;
    const compiled = law("nothing in a toolbar sits closer than 6px");
    const { edit } = lawConfigEdit(
      value,
      compiled,
      "Toolbar law.",
      '[role="toolbar"]',
    );
    if (edit === undefined) throw new Error("expected an edit");
    const after = lawEditText(before, edit, value);
    expect(JSON.parse(after)).toEqual(value);
    expect(after.startsWith(`{\n  "version": 1,\n  "baseUrl"`)).toBe(true);
  });
});
