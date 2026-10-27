import type { Request } from "playwright";
import type { ProbeSafetyPolicy } from "../checks/types.js";

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

/** Dev-server and asset chatter that is never an effect of an action. */
export const ignoredRequest = (request: Pick<Request, "url">) =>
  /(?:webpack-hmr|__nextjs|_next\/static|hot-update|favicon|\/__vite|sockjs)/.test(
    request.url(),
  );

/**
 * The same request policy applies to focus sweeps and every probe context.
 * A third-party page gets no dev-server exemption.
 */
export function probeRequestAllowed(
  request: Pick<Request, "method" | "url">,
  policy: ProbeSafetyPolicy = "app",
): boolean {
  if (safeMethods.has(request.method())) return true;
  return policy === "app" && ignoredRequest(request);
}
