import { IdiomError } from "../../errors.js";

/** Injected in tests; defaults are global fetch and process.env. */
export type FigmaDependencies = {
  fetch?: typeof fetch | undefined;
  env?: Record<string, string | undefined> | undefined;
};

export const FIGMA_API = "https://api.figma.com";

const tokenHowTo = [
  "Create a Figma personal access token: Figma account menu → Settings → Security → Personal access tokens → Generate new token.",
  "Give it the file_content:read scope (add file_variables:read to resolve variable names), then `export FIGMA_TOKEN=<token>`.",
].join(" ");

export function figmaToken(deps: FigmaDependencies = {}): string {
  const token = (deps.env ?? process.env).FIGMA_TOKEN?.trim();
  if (!token)
    throw new IdiomError(
      `FIGMA_TOKEN is not set; Idiom needs it to fetch the Figma frame. ${tokenHowTo}`,
    );
  return token;
}

export class FigmaHttpError extends IdiomError {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** One GET against the Figma REST API. No retries; the token never appears in errors. */
export async function figmaGet<T>(
  path: string,
  deps: FigmaDependencies = {},
  what = "Figma file",
): Promise<T> {
  const token = figmaToken(deps);
  const request = deps.fetch ?? fetch;
  let response: Response;
  try {
    response = await request(`${FIGMA_API}${path}`, {
      headers: { "X-Figma-Token": token },
    });
  } catch (error) {
    throw new IdiomError(
      `Could not reach the Figma API: ${scrub(error instanceof Error ? error.message : String(error), token)}`,
    );
  }
  if (response.ok) return (await response.json()) as T;
  let detail = "";
  try {
    const body = (await response.json()) as {
      err?: unknown;
      message?: unknown;
    };
    detail = String(body.err ?? body.message ?? "");
  } catch {}
  detail = scrub(detail, token);
  if (response.status === 403)
    throw new FigmaHttpError(
      `Figma rejected FIGMA_TOKEN for this ${what} (403${detail ? `: ${detail}` : ""}); it may be expired, revoked or missing a scope. ${tokenHowTo}`,
      403,
    );
  if (response.status === 404)
    throw new FigmaHttpError(
      `Figma ${what} not found (404); check the URL and that the file is shared with the token's account.`,
      404,
    );
  if (response.status === 429)
    throw new FigmaHttpError(
      "Figma rate limited the request (429); retry later.",
      429,
    );
  throw new FigmaHttpError(
    `Figma API answered ${response.status}${detail ? `: ${detail}` : ""}.`,
    response.status,
  );
}

/** A rendered image URL is pre-signed; it is fetched without the token. */
export async function figmaDownload(
  url: string,
  deps: FigmaDependencies = {},
): Promise<Buffer> {
  const request = deps.fetch ?? fetch;
  let response: Response;
  try {
    response = await request(url);
  } catch (error) {
    throw new IdiomError(
      `Could not download the Figma frame render: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok)
    throw new IdiomError(
      `Downloading the Figma frame render failed (${response.status}).`,
    );
  return Buffer.from(await response.arrayBuffer());
}

const scrub = (text: string, token: string) =>
  token ? text.split(token).join("<FIGMA_TOKEN>") : text;
