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
  const mainOf = () =>
    document.querySelector("main, [role=main]") ?? document.body;
  const actionEvents = (action: string) =>
    action === "click"
      ? ["pointerdown", "click"]
      : action === "press"
        ? ["keydown"]
        : action === "select"
          ? ["input", "change"]
          : ["keydown", "beforeinput", "input"];
  // Fill and select can dispatch on a label's associated control. Resolve the
  // association at dispatch, so replacements during Playwright's wait remain
  // aligned with its live retargeting.
  const dispatchTarget = (
    event: Event,
    trigger: Element | null,
    selector: string,
    action: string,
  ): Element | undefined => {
    let target = trigger;
    if (
      trigger !== null &&
      (action === "fill" || action === "select") &&
      !trigger.matches("input, textarea, select") &&
      !(trigger instanceof HTMLElement && trigger.isContentEditable)
    )
      target = trigger.closest("label")?.control ?? trigger;
    return event.composedPath().find((node): node is Element => {
      if (!(node instanceof Element)) return false;
      if (node === target) return true;
      try {
        return node.matches(selector);
      } catch {
        return false;
      }
    });
  };
  const infinite = (animation: Animation) =>
    animation.effect?.getTiming().iterations === Number.POSITIVE_INFINITY;
  const animationTarget = (animation: Animation) => {
    const target = (animation.effect as KeyframeEffect | null)?.target;
    return target instanceof Element ? target : null;
  };
  const indicatorBaseline = (options: { visibleAnimationsOnly: boolean }) => {
    const status = new WeakMap<Element, string>();
    for (const region of document.querySelectorAll(statusSelector))
      status.set(region, rendered(region) ? textOf(region) : "");
    return {
      progress: new WeakSet<Element>(
        [...document.querySelectorAll(progressSelector)].filter(rendered),
      ),
      animations: new WeakSet<Animation>(
        document.getAnimations().filter((animation) => {
          if (!infinite(animation)) return false;
          if (!options.visibleAnimationsOnly) return true;
          const target = animationTarget(animation);
          return target !== null && rendered(target);
        }),
      ),
      status,
    };
  };
  // Indicators in a fixed order: progressbar/busy, spinner, status text,
  // control text. `visit` returns true to stop at the first hit.
  const scanIndicators = (
    baseline: IndicatorBaseline,
    options: {
      trigger: Element | null;
      triggerText: string;
      records?: MutationRecord[];
      skipTrigger: boolean;
      rebusyBaseline: boolean;
      isNoisy?: (element: Element) => boolean;
      onTrigger?: (trigger: Element) => void;
      visit: IndicatorVisit;
    },
  ): boolean => {
    const { trigger, visit, isNoisy } = options;
    const records = options.records ?? [];
    for (const element of document.querySelectorAll(progressSelector)) {
      const becameBusy =
        options.rebusyBaseline &&
        element.getAttribute("aria-busy") === "true" &&
        records.some(
          (mutation) =>
            mutation.target === element &&
            mutation.attributeName === "aria-busy" &&
            mutation.oldValue !== "true",
        );
      if ((baseline.progress.has(element) && !becameBusy) || !rendered(element))
        continue;
      if (options.skipTrigger && element === trigger) continue;
      if (
        visit(
          element.getAttribute("aria-busy") === "true" &&
            !element.matches("[role=progressbar], progress")
            ? "busy"
            : "progressbar",
          element,
        )
      )
        return true;
    }
    for (const animation of document.getAnimations()) {
      if (!infinite(animation) || baseline.animations.has(animation)) continue;
      const target = animationTarget(animation);
      if (target && rendered(target) && !isNoisy?.(target))
        if (visit("spinner", target)) return true;
    }
    for (const region of document.querySelectorAll(statusSelector)) {
      if (!rendered(region) || isNoisy?.(region)) continue;
      const text = textOf(region);
      if (text !== "" && text !== (baseline.status.get(region) ?? ""))
        if (visit("status-text", region, text)) return true;
    }
    if (trigger?.isConnected) {
      options.onTrigger?.(trigger);
      if (rendered(trigger)) {
        const text = textOf(trigger);
        if (text !== "" && text !== options.triggerText)
          if (visit("control-text", trigger, text)) return true;
      }
    }
    return false;
  };
  // Progress words in added nodes and changed text. `onNode` sees every
  // rendered node after its own progress-text visit.
  const addedProgressText = (
    records: MutationRecord[],
    visit: IndicatorVisit,
    onNode?: (node: Node, element: Element) => void,
  ): boolean => {
    for (const mutation of records) {
      const nodes =
        mutation.type === "characterData"
          ? [mutation.target]
          : mutation.type === "attributes"
            ? []
            : [...mutation.addedNodes];
      for (const node of nodes) {
        const element = node instanceof Element ? node : node.parentElement;
        if (element === null || !rendered(element)) continue;
        const text = normalize(
          node instanceof HTMLElement ? node.innerText : node.textContent,
        );
        if (progressText(text))
          if (visit("progress-text", element, text)) return true;
        onNode?.(node, element);
      }
    }
    return false;
  };
  // Subtrees that change while nobody acts. Membership covers descendants.
  const noiseSet = () => {
    const noisy = new Set<Element>();
    const has = (element: Element) => {
      for (
        let current: Element | null = element;
        current;
        current = current.parentElement
      )
        if (noisy.has(current)) return true;
      return false;
    };
    return {
      add: (element: Element) => {
        noisy.add(element);
      },
      has,
      markRecords: (records: MutationRecord[], except: Element[]) => {
        for (const record of records) {
          const element =
            record.target instanceof Element
              ? record.target
              : record.target.parentElement;
          if (element && !except.includes(element)) noisy.add(element);
        }
      },
    };
  };
  // Subtrees marked by general carousel, ticker and autoplay patterns.
  const noiseMarkers =
    "[aria-roledescription], marquee, [autoplay], [data-autoplay], [data-ride=carousel], [data-bs-ride]";
  const noiseToken =
    /(?:^|[\s_-])(?:carousel|slideshow|swiper|ticker|marquee|rotator)(?:$|[\s_-])/i;
  const structurallyNoisy = (element: Element) =>
    (element.matches(noiseMarkers) &&
      (!element.hasAttribute("aria-roledescription") ||
        /carousel|slide/i.test(
          element.getAttribute("aria-roledescription") ?? "",
        ))) ||
    noiseToken.test(
      typeof element.className === "string" ? element.className : "",
    ) ||
    noiseToken.test(element.id);
  const structuralNoise = (root: ParentNode = document): Element[] => {
    const found: Element[] = [];
    if (root instanceof Element && structurallyNoisy(root)) found.push(root);
    let count = 0;
    for (const element of root.querySelectorAll(
      `${noiseMarkers}, [class], [id]`,
    )) {
      if (count++ > 10_000) break;
      if (structurallyNoisy(element)) found.push(element);
    }
    return found;
  };
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
    mainOf,
    actionEvents,
    dispatchTarget,
    infinite,
    animationTarget,
    indicatorBaseline,
    scanIndicators,
    addedProgressText,
    noiseSet,
    structuralNoise,
  };
}
export type IndicatorKind =
  | "progressbar"
  | "busy"
  | "spinner"
  | "status-text"
  | "control-text"
  | "progress-text";
type IndicatorVisit = (
  kind: IndicatorKind,
  element: Element,
  text?: string,
) => boolean | undefined;
type IndicatorBaseline = {
  progress: WeakSet<Element>;
  animations: WeakSet<Animation>;
  status: WeakMap<Element, string>;
};
export type NoiseSet = {
  add(element: Element): void;
  has(element: Element): boolean;
  markRecords(records: MutationRecord[], except: Element[]): void;
};
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
    mainOf(): Element;
    actionEvents(action: string): string[];
    dispatchTarget(
      event: Event,
      trigger: Element | null,
      selector: string,
      action: string,
    ): Element | undefined;
    infinite(animation: Animation): boolean;
    animationTarget(animation: Animation): Element | null;
    indicatorBaseline(options: {
      visibleAnimationsOnly: boolean;
    }): IndicatorBaseline;
    scanIndicators(
      baseline: IndicatorBaseline,
      options: {
        trigger: Element | null;
        triggerText: string;
        records?: MutationRecord[];
        skipTrigger: boolean;
        rebusyBaseline: boolean;
        isNoisy?: (element: Element) => boolean;
        onTrigger?: (trigger: Element) => void;
        visit: IndicatorVisit;
      },
    ): boolean;
    addedProgressText(
      records: MutationRecord[],
      visit: IndicatorVisit,
      onNode?: (node: Node, element: Element) => void,
    ): boolean;
    noiseSet(): NoiseSet;
    structuralNoise(root?: ParentNode): Element[];
  };
};
