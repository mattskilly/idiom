/** A Figma file (and optionally one node in it) addressed by a share URL. */
export type FigmaRef = {
  /** API file key; a branch key when the URL names a branch. */
  fileKey: string;
  /** API node id (`12:34`); URLs carry it as `12-34`. */
  nodeId?: string | undefined;
  /** A pinned file version from `version-id`. */
  version?: string | undefined;
  url: string;
};

export const isFigmaHost = (host: string) =>
  /^(?:www\.)?figma\.com$/i.test(host);

/** Undefined for anything that is not a figma.com design, file or proto URL. */
export function parseFigmaUrl(input: string): FigmaRef | undefined {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || !isFigmaHost(url.hostname)) return undefined;
  const parts = url.pathname.split("/").filter(Boolean);
  if (!["design", "file", "proto"].includes(parts[0] ?? "")) return undefined;
  const key = parts[1];
  if (!key || !/^[A-Za-z0-9]+$/.test(key)) return undefined;
  const branch =
    parts[2] === "branch" && parts[3] && /^[A-Za-z0-9]+$/.test(parts[3])
      ? parts[3]
      : undefined;
  const node = url.searchParams.get("node-id")?.trim();
  const version = url.searchParams.get("version-id")?.trim();
  return {
    fileKey: branch ?? key,
    ...(node ? { nodeId: node.replace(/-/g, ":") } : {}),
    ...(version ? { version } : {}),
    url: input.trim(),
  };
}

export function figmaNodeLink(fileKey: string, nodeId: string): string {
  return `https://www.figma.com/design/${fileKey}/?node-id=${encodeURIComponent(nodeId.replace(/:/g, "-"))}`;
}
