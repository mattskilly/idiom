import { z } from "zod";

/** Every field optional and passed through: node type pages do not document every field on every type. */
const colorSchema = z
  .object({
    r: z.number(),
    g: z.number(),
    b: z.number(),
    a: z.number().optional(),
  })
  .loose();
export type FigmaColor = z.infer<typeof colorSchema>;
const paintSchema = z
  .object({
    type: z.string(),
    visible: z.boolean().optional(),
    opacity: z.number().optional(),
    color: colorSchema.optional(),
    boundVariables: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();
export type FigmaPaint = z.infer<typeof paintSchema>;
const boxSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
  })
  .loose();

export type FigmaNode = {
  id: string;
  name?: string | undefined;
  type: string;
  visible?: boolean | undefined;
  opacity?: number | undefined;
  children?: FigmaNode[] | undefined;
  absoluteBoundingBox?: z.infer<typeof boxSchema> | null | undefined;
  fills?: FigmaPaint[] | undefined;
  strokes?: FigmaPaint[] | undefined;
  strokeWeight?: number | undefined;
  individualStrokeWeights?:
    | { top: number; right: number; bottom: number; left: number }
    | undefined;
  strokeAlign?: string | undefined;
  cornerRadius?: number | undefined;
  rectangleCornerRadii?: number[] | undefined;
  layoutMode?: string | undefined;
  itemSpacing?: number | undefined;
  paddingLeft?: number | undefined;
  paddingRight?: number | undefined;
  paddingTop?: number | undefined;
  paddingBottom?: number | undefined;
  characters?: string | undefined;
  style?:
    | {
        fontFamily?: string | undefined;
        fontWeight?: number | undefined;
        fontSize?: number | undefined;
        lineHeightPx?: number | undefined;
        lineHeightUnit?: string | undefined;
        letterSpacing?: number | undefined;
        textAlignHorizontal?: string | undefined;
      }
    | undefined;
  componentId?: string | undefined;
  boundVariables?: Record<string, unknown> | undefined;
};

export const figmaNodeSchema: z.ZodType<FigmaNode> = z.lazy(() =>
  z
    .object({
      id: z.string().min(1),
      name: z.string().optional(),
      type: z.string().min(1),
      visible: z.boolean().optional(),
      opacity: z.number().optional(),
      children: z.array(figmaNodeSchema).optional(),
      absoluteBoundingBox: boxSchema.nullable().optional(),
      fills: z.array(paintSchema).optional(),
      strokes: z.array(paintSchema).optional(),
      strokeWeight: z.number().optional(),
      individualStrokeWeights: z
        .object({
          top: z.number(),
          right: z.number(),
          bottom: z.number(),
          left: z.number(),
        })
        .loose()
        .optional(),
      strokeAlign: z.string().optional(),
      cornerRadius: z.number().optional(),
      rectangleCornerRadii: z.array(z.number()).length(4).optional(),
      layoutMode: z.string().optional(),
      itemSpacing: z.number().optional(),
      paddingLeft: z.number().optional(),
      paddingRight: z.number().optional(),
      paddingTop: z.number().optional(),
      paddingBottom: z.number().optional(),
      characters: z.string().optional(),
      style: z
        .object({
          fontFamily: z.string().optional(),
          fontWeight: z.number().optional(),
          fontSize: z.number().optional(),
          lineHeightPx: z.number().optional(),
          lineHeightUnit: z.string().optional(),
          letterSpacing: z.number().optional(),
          textAlignHorizontal: z.string().optional(),
        })
        .loose()
        .optional(),
      componentId: z.string().optional(),
      boundVariables: z.record(z.string(), z.unknown()).optional(),
    })
    .loose(),
) as z.ZodType<FigmaNode>;

export const figmaFileSchema = z
  .object({
    name: z.string().optional(),
    version: z.string().min(1),
    lastModified: z.string().optional(),
  })
  .loose();

export const figmaNodesSchema = z
  .object({
    nodes: z.record(
      z.string(),
      z.object({ document: figmaNodeSchema }).loose().nullable(),
    ),
  })
  .loose();

export const figmaImagesSchema = z
  .object({
    err: z.string().nullable().optional(),
    images: z.record(z.string(), z.string().nullable()),
  })
  .loose();

const aliasSchema = z
  .object({ type: z.literal("VARIABLE_ALIAS"), id: z.string() })
  .loose();
export const figmaVariablesSchema = z
  .object({
    meta: z
      .object({
        variables: z.record(
          z.string(),
          z
            .object({
              id: z.string(),
              name: z.string(),
              variableCollectionId: z.string(),
              resolvedType: z.string(),
              valuesByMode: z.record(z.string(), z.unknown()),
              remote: z.boolean().optional(),
              scopes: z.array(z.string()).optional(),
            })
            .loose(),
        ),
        variableCollections: z.record(
          z.string(),
          z
            .object({
              name: z.string(),
              modes: z.array(
                z.object({ modeId: z.string(), name: z.string() }).loose(),
              ),
              defaultModeId: z.string(),
            })
            .loose(),
        ),
      })
      .loose(),
  })
  .loose();
export type FigmaVariables = z.infer<typeof figmaVariablesSchema>;
export const isVariableAlias = (
  value: unknown,
): value is z.infer<typeof aliasSchema> => aliasSchema.safeParse(value).success;

export const figmaMetaSchema = z
  .object({
    fileKey: z.string(),
    nodeId: z.string(),
    version: z.string(),
    lastModified: z.string().optional(),
    name: z.string().optional(),
    fetchedAt: z.string(),
    scale: z.number(),
    variables: z.string(),
    link: z.string(),
  })
  .strict();
export type FigmaMeta = z.infer<typeof figmaMetaSchema>;
