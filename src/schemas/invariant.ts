import { z } from "zod";

const nonempty = z.string().trim().min(1);
const pixels = z.number().finite().nonnegative();
/** A size: an exact CSS pixel value or an inclusive `{min,max}` range. */
export const invariantDimensionSchema = z.union([
  pixels,
  z
    .object({ min: pixels, max: pixels })
    .strict()
    .refine(({ min, max }) => min <= max, "min must not exceed max"),
]);
const common = {
  name: nonempty.optional(),
  optional: z.boolean().default(false),
  tolerance: pixels.default(0),
};
export const invariantEdges = ["top", "right", "bottom", "left"] as const;
export type InvariantEdge = (typeof invariantEdges)[number];
export const invariantShares = [...invariantEdges, "width", "height"] as const;
export type InvariantShare = (typeof invariantShares)[number];

/** Split only the final edge suffix, preserving CSS pseudo-classes. */
export function parseInvariantEdge(value: string): {
  selector: string;
  edge: InvariantEdge;
} {
  const match = /^(.*):(top|right|bottom|left)$/s.exec(value);
  if (!match?.[1]?.trim())
    throw new Error(`invalid invariant edge ${JSON.stringify(value)}`);
  return { selector: match[1].trim(), edge: match[2] as InvariantEdge };
}
const edge = nonempty.refine((value) => {
  try {
    parseInvariantEdge(value);
    return true;
  } catch {
    return false;
  }
}, "must end with :top, :right, :bottom, or :left after a nonempty selector");

export const invariantSchema = z.union([
  z
    .object({
      ...common,
      selector: nonempty,
      width: invariantDimensionSchema.optional(),
      height: invariantDimensionSchema.optional(),
    })
    .strict()
    .refine(
      (value) => value.width !== undefined || value.height !== undefined,
      "must declare width or height",
    ),
  z
    .object({
      ...common,
      align: z.enum(invariantEdges),
      selectors: z
        .array(nonempty)
        .min(2)
        .refine(
          (values) => new Set(values).size === values.length,
          "selectors must be distinct",
        ),
    })
    .strict(),
  z
    .object({ ...common, edge, equals: edge, offset: z.number().finite() })
    .strict()
    .refine((value) => {
      try {
        const horizontal = (side: InvariantEdge) =>
          side === "left" || side === "right";
        return (
          horizontal(parseInvariantEdge(value.edge).edge) ===
          horizontal(parseInvariantEdge(value.equals).edge)
        );
      } catch {
        return false;
      }
    }, "edges must be on the same axis"),
  z
    .object({
      ...common,
      /** The edge or dimension every match shares (within each container). */
      share: z.enum(invariantShares),
      selector: nonempty,
      /** Compare matches only against others inside the same container. */
      within: nonempty.optional(),
    })
    .strict(),
  z
    .object({
      name: common.name,
      optional: common.optional,
      group: nonempty,
      items: nonempty,
      owner: nonempty.optional(),
      attribute: nonempty.optional(),
      text: nonempty
        .refine((value) => {
          try {
            new RegExp(value);
            return true;
          } catch {
            return false;
          }
        }, "must be a valid regular expression")
        .optional(),
    })
    .strict()
    .refine(
      (value) => (value.attribute === undefined) !== (value.text === undefined),
      "must declare exactly one of attribute or text",
    ),
]);
export type Invariant = z.infer<typeof invariantSchema>;
export type InvariantInput = z.input<typeof invariantSchema>;
export type GroupInvariant = Extract<Invariant, { group: string }>;
export type LayoutInvariant = Exclude<Invariant, GroupInvariant>;
export type ShareInvariant = Extract<Invariant, { share: InvariantShare }>;
export type SizeInvariant = Exclude<
  Extract<Invariant, { selector: string }>,
  ShareInvariant
>;

export function isGroupInvariant(
  declaration: Invariant,
): declaration is GroupInvariant {
  return "group" in declaration;
}

/**
 * The membership value a group invariant compares: the raw attribute, or the
 * regex's first capture group (whole match without groups) over the text.
 * Null when the element carries no value, so membership is unproven.
 */
export function groupValue(
  declaration: GroupInvariant,
  raw: string | null,
): string | null {
  if (raw === null) return null;
  if (declaration.text === undefined) return raw;
  const match = new RegExp(declaration.text).exec(raw);
  return match === null ? null : (match[1] ?? match[0]);
}

/** What a group invariant's members must share, for messages. */
export function groupBasis(declaration: GroupInvariant): string {
  return declaration.attribute ?? `text /${declaration.text}/`;
}
export const invariantOriginSchema = z
  .object({
    scope: z.enum(["project", "flow", "state"]),
    id: nonempty,
    index: z.number().int().nonnegative(),
  })
  .strict();
export type EffectiveInvariant = {
  declaration: Invariant;
  origin: z.infer<typeof invariantOriginSchema>;
};

/**
 * The invariants a state is measured against: the project's (learned laws),
 * then the flow's, then the state's own.
 */
export function effectiveInvariants(
  flow: { id: string; invariants?: Invariant[] | undefined },
  state: { id: string; invariants?: Invariant[] | undefined },
  project?: Invariant[] | undefined,
): EffectiveInvariant[] {
  const projectWide = (project ?? []).map((declaration, index) => ({
    declaration,
    origin: { scope: "project" as const, id: "project", index },
  }));
  return [
    ...projectWide,
    ...(["flow", "state"] as const).flatMap((scope) => {
      const source = scope === "flow" ? flow : state;
      return (source.invariants ?? []).map((declaration, index) => ({
        declaration,
        origin: { scope, id: source.id, index },
      }));
    }),
  ];
}

export function invariantSelectors(declaration: Invariant): string[] {
  if ("share" in declaration)
    return [
      ...new Set([
        declaration.selector,
        ...(declaration.within === undefined ? [] : [declaration.within]),
      ]),
    ];
  if ("selector" in declaration) return [declaration.selector];
  if ("align" in declaration) return declaration.selectors;
  if ("group" in declaration)
    return [
      ...new Set([
        declaration.group,
        ...(declaration.owner === undefined ? [] : [declaration.owner]),
      ]),
    ];
  return [
    ...new Set([
      parseInvariantEdge(declaration.edge).selector,
      parseInvariantEdge(declaration.equals).selector,
    ]),
  ];
}

export function invariantLabel({
  declaration,
  origin,
}: EffectiveInvariant): string {
  const subject =
    "share" in declaration
      ? `${declaration.share} shared by ${declaration.selector}${declaration.within === undefined ? "" : ` within ${declaration.within}`}`
      : "selector" in declaration
        ? declaration.selector
        : "align" in declaration
          ? `${declaration.align} alignment (${declaration.selectors.join(", ")})`
          : "group" in declaration
            ? `group ${declaration.group} › ${declaration.items} by ${groupBasis(declaration)}`
            : `${declaration.edge} offset from ${declaration.equals}`;
  return (
    declaration.name ??
    `${subject} (${origin.scope} ${origin.id} #${origin.index + 1})`
  );
}
