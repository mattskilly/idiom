/** Serializable installation: each watcher owns its observers and timing. */
export function installFeedback(): void {
  const rendered = (element: Element | null): boolean => {
    if (element === null || !element.isConnected) return false;
    if (element.getClientRects().length === 0) return false;
    const style = getComputedStyle(element);
    if (style.visibility !== "visible") return false;
    for (
      let current: Element | null = element;
      current;
      current = current.parentElement
    ) {
      const ancestor = getComputedStyle(current);
      if (ancestor.display === "none" || Number(ancestor.opacity) <= 0)
        return false;
    }
    return true;
  };
  const selectorFor = (element: Element): string => {
    if (element === document.documentElement) return "html";
    if (element === document.body) return "body";
    if (
      element.id &&
      document.querySelectorAll(`#${CSS.escape(element.id)}`).length === 1
    )
      return `#${CSS.escape(element.id)}`;
    for (const attr of ["data-testid", "aria-label", "role"]) {
      const value = element.getAttribute(attr);
      if (!value) continue;
      const candidate = `${element.tagName.toLowerCase()}[${attr}=${JSON.stringify(value)}]`;
      if (document.querySelectorAll(candidate).length === 1) return candidate;
    }
    const classes = [...element.classList].sort().slice(0, 3);
    if (classes.length) {
      const candidate = `${element.tagName.toLowerCase()}${classes.map((value) => `.${CSS.escape(value)}`).join("")}`;
      if (document.querySelectorAll(candidate).length === 1) return candidate;
    }
    const parts: string[] = [];
    let current: Element | null = element;
    while (current !== null && current !== document.body) {
      const siblings: Element[] = current.parentElement
        ? [...current.parentElement.children].filter(
            (child) => child.tagName === current?.tagName,
          )
        : [];
      parts.unshift(
        siblings.length > 1
          ? `${current.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(current) + 1})`
          : current.tagName.toLowerCase(),
      );
      current = current.parentElement;
    }
    return `body > ${parts.join(" > ")}`;
  };
  const normalize = (value: string | null | undefined) =>
    (value ?? "").replace(/\s+/g, " ").trim();
  const textOf = (element: Element) =>
    normalize(
      element.getAttribute("aria-label") ||
        (element instanceof HTMLElement
          ? element.innerText
          : element.textContent),
    );
  const progressSelector = "[role=progressbar], progress, [aria-busy=true]";
  const statusSelector =
    "[role=status], [role=log], [aria-live]:not([aria-live=off]), output";
  const progressWords =
    /\b(loading|saving|generating|working|processing|thinking|uploading|sending|submitting|please wait)\b/i;
  const progressText = (text: string) =>
    text !== "" && (progressWords.test(text) || /(?:…|\.\.\.)$/.test(text));
  const skeletal = (element: Element) =>
    /skeleton|shimmer|placeholder|loading/i.test(
      typeof element.className === "string" ? element.className : "",
    ) ||
    [...element.attributes].some(
      (attribute) =>
        attribute.name.startsWith("data-") &&
        /skeleton|shimmer|placeholder|loading/i.test(
          `${attribute.name} ${attribute.value}`,
        ),
    );
  (window as unknown as FeedbackWindow).__idiomFeedback = {
    rendered,
    selectorFor,
    normalize,
    textOf,
    progressSelector,
    statusSelector,
    progressWords,
    progressText,
    skeletal,
  };
}
export type FeedbackWindow = Window & {
  __idiomFeedback: {
    rendered(element: Element | null): boolean;
    selectorFor(element: Element): string;
    normalize(value: string | null | undefined): string;
    textOf(element: Element): string;
    progressSelector: string;
    statusSelector: string;
    progressWords: RegExp;
    progressText(text: string): boolean;
    skeletal(element: Element): boolean;
  };
};
