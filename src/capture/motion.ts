import type { Page } from "playwright";
import { linkRecording } from "../checks/temporal-evidence.js";
import type {
  MotionAction,
  MotionArtifact,
  MotionChange,
  MotionEffect,
  MotionSample,
} from "../checks/types.js";

type ActionIdentity = Pick<
  MotionAction,
  "source" | "selector" | "name" | "stepIndex"
>;
type BrowserWindow = Window & {
  __idiomMotion?: { token: string; finish(): MotionAction; dispose(): void };
};

/** Temporal collection is action-local and never changes media or replays an action. */
export class MotionCollector {
  private actions: MotionAction[] = [];
  private reducedMotion = false;
  constructor(
    private page: Page,
    private selectors: string[] = [],
  ) {}

  /** Also record the effective preference when guards leave no measured actions. */
  async initialize(): Promise<void> {
    const preference = await this.page
      .evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)
      .catch(() => undefined);
    if (typeof preference === "boolean") this.reducedMotion = preference;
  }

  async start(
    identity: ActionIdentity,
    recording?: string,
  ): Promise<{
    finish(reason?: string): Promise<void>;
    dispose(): Promise<void>;
  }> {
    const token = `${Date.now()}:${Math.random()}`;
    let failure: string | undefined;
    try {
      this.reducedMotion = await this.page.evaluate(
        ({ identity, selectors, token }) => {
          const scope = window as BrowserWindow;
          scope.__idiomMotion?.dispose();
          const notes: string[] = [];
          const defaults =
            "dialog, aside, details, [role=dialog], [role=alertdialog], [role=menu], [role=listbox], [role=region], [aria-modal=true], [popover]";
          const valid = selectors.filter((selector) => {
            try {
              document.querySelector(selector);
              return true;
            } catch {
              notes.push(`invalid motion surface selector: ${selector}`);
              return false;
            }
          });
          const surfaces = [defaults, ...valid].join(", ");
          const candidates = `${surfaces}, [role=tooltip]`;
          const pathFor = (element: Element): string => {
            if (element === document.documentElement) return "html";
            if (element === document.body) return "body";
            const generatedId =
              /(?:^|[-_])(?::r[0-9a-z]+:|«r[0-9a-z]+»|_r_[0-9a-z]+_)|^radix-|^headlessui-/.test(
                element.id,
              );
            if (
              element.id &&
              !generatedId &&
              document.querySelectorAll(`#${CSS.escape(element.id)}`).length ===
                1
            )
              return `#${CSS.escape(element.id)}`;
            for (const attr of [
              "data-testid",
              "data-test",
              "data-id",
              "name",
              "aria-label",
              "role",
            ]) {
              const value = element.getAttribute(attr);
              if (!value) continue;
              const selector = `${element.tagName.toLowerCase()}[${attr}=${JSON.stringify(value)}]`;
              if (document.querySelectorAll(selector).length === 1)
                return selector;
            }
            const classes = [...element.classList]
              .filter(
                (value) =>
                  !(
                    /__[A-Za-z0-9_-]{5,}$/.test(value) ||
                    /^(?:css|jsx|sc|emotion|styled)[-_][A-Za-z0-9_-]{5,}$/i.test(
                      value,
                    ) ||
                    /^[a-f0-9]{8,}$/i.test(value)
                  ),
              )
              .sort()
              .slice(0, 3);
            if (classes.length) {
              const selector = `${element.tagName.toLowerCase()}${classes.map((value) => `.${CSS.escape(value)}`).join("")}`;
              if (document.querySelectorAll(selector).length === 1)
                return selector;
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
          const label = (element: Element): string =>
            (
              element.getAttribute("aria-label") ||
              (element.getAttribute("aria-labelledby") ?? "")
                .split(/\s+/)
                .map((id) => document.getElementById(id)?.textContent ?? "")
                .join(" ")
                .trim() ||
              element.querySelector("h1,h2,h3,h4,[role=heading]")
                ?.textContent ||
              (element.matches("[role=tooltip]")
                ? "tooltip"
                : element.tagName.toLowerCase())
            )
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 120);
          const sample = (element: Element): MotionSample | null => {
            if (!element.isConnected) return null;
            const style = getComputedStyle(element);
            const box = element.getBoundingClientRect();
            let rendered = box.width > 0 && box.height > 0;
            for (
              let current: Element | null = element;
              current;
              current = current.parentElement
            ) {
              const css = getComputedStyle(current);
              if (css.display === "none" || css.visibility === "hidden")
                rendered = false;
            }
            return {
              rect: {
                x: box.x,
                y: box.y,
                width: box.width,
                height: box.height,
              },
              opacity: Number(style.opacity),
              rendered,
              transform: style.transform,
              state: [
                "open",
                "aria-expanded",
                "data-state",
                "hidden",
                "class",
                "style",
              ]
                .map((attr) => `${attr}=${element.getAttribute(attr)}`)
                .join("|"),
              transition: style.transition,
              animation: style.animation,
              motion: {
                transitionProperty: style.transitionProperty,
                transitionDuration: style.transitionDuration,
                transitionDelay: style.transitionDelay,
                animationName: style.animationName,
                animationDuration: style.animationDuration,
                animationDelay: style.animationDelay,
                animationIterationCount: style.animationIterationCount,
                animationPlayState: style.animationPlayState,
              },
            };
          };
          // Ignore subpixel layout rounding; opacity is unitless.
          const diff = (
            a: MotionSample | null,
            b: MotionSample | null,
          ): MotionChange["changed"] => {
            const result: MotionChange["changed"] = [];
            if ((a?.rendered ?? false) !== (b?.rendered ?? false))
              result.push("presence");
            if (a && b) {
              if (
                Math.abs(a.rect.width - b.rect.width) > 0.5 ||
                Math.abs(a.rect.height - b.rect.height) > 0.5
              )
                result.push("size");
              if (
                Math.abs(a.rect.x - b.rect.x) > 0.5 ||
                Math.abs(a.rect.y - b.rect.y) > 0.5
              )
                result.push("position");
              if (Math.abs(a.opacity - b.opacity) > 0.001)
                result.push("opacity");
              if (a.transform !== b.transform) result.push("transform");
            }
            return result;
          };
          type Entry = {
            element: Element;
            owner: Element;
            selector: string;
            name: string;
            ownerSelector: string;
            ownerName: string;
            before: MotionSample | null;
            samples: MotionSample[];
            effects: MotionEffect[];
            changed: Set<MotionChange["changed"][number]>;
          };
          const entries = new Map<Element, Entry>();
          let initial = true;
          const add = (element: Element, owner: Element) => {
            const existing = entries.get(element);
            if (existing) {
              // A nested surface owns its own subtree, not the enclosing panel.
              if (
                existing.owner !== owner &&
                existing.owner !== element &&
                existing.owner.contains(owner)
              ) {
                existing.owner = owner;
                existing.ownerSelector = pathFor(owner);
                existing.ownerName = label(owner);
              }
              return;
            }
            const before = sample(element);
            entries.set(element, {
              element,
              owner,
              selector: pathFor(element),
              name: label(element),
              ownerSelector: pathFor(owner),
              ownerName: label(owner),
              before: initial ? before : null,
              samples: before === null ? [] : [before],
              effects: [],
              changed: new Set(),
            });
          };
          const discover = () => {
            for (const owner of document.querySelectorAll(candidates)) {
              add(owner, owner);
              // Preserve individual targets so bubbling events cannot be counted on ancestors.
              for (const child of owner.querySelectorAll("*"))
                add(child, owner);
              const parent = owner.parentElement;
              if (
                parent &&
                !parent.matches("body,html") &&
                !parent.matches(candidates) &&
                [...parent.querySelectorAll(candidates)].every((other) =>
                  owner.contains(other),
                )
              )
                add(parent, owner);
            }
          };
          discover();
          initial = false;
          const trigger = (() => {
            try {
              return document.querySelector(identity.selector);
            } catch {
              return null;
            }
          })();
          if (trigger) identity.selector = pathFor(trigger);
          const controls = (trigger?.getAttribute("aria-controls") ?? "").split(
            /\s+/,
          );
          const triggerState = trigger ? sample(trigger)?.state : undefined;
          const baseline = new Set(document.getAnimations());
          const baselineTargets = new Set(
            [...baseline].flatMap((animation) =>
              animation.effect instanceof KeyframeEffect &&
              animation.effect.target instanceof Element
                ? [animation.effect.target]
                : [],
            ),
          );
          const effects = new Map<Animation, MotionEffect>();
          const animationCleanup: Array<() => void> = [];
          const relevant =
            /^(opacity|transform|translate|scale|rotate|width|height|minWidth|maxWidth|minHeight|maxHeight|left|right|top|bottom|inset|flexBasis|gridTemplateColumns|gridTemplateRows|margin.*|padding.*|clipPath)$/;
          const scanEffects = () => {
            for (const animation of document.getAnimations()) {
              if (baseline.has(animation)) continue;
              const effect = animation.effect;
              if (
                !(effect instanceof KeyframeEffect) ||
                !(effect.target instanceof Element)
              )
                continue;
              const target = effect.target;
              const entry = entries.get(target);
              if (!entry) continue;
              const frames = effect.getKeyframes();
              const properties = [
                ...new Set(frames.flatMap((frame) => Object.keys(frame))),
              ].filter(
                (key) =>
                  relevant.test(key) &&
                  new Set(frames.map((frame) => JSON.stringify(frame[key])))
                    .size > 1,
              );
              if (properties.length === 0) continue;
              // A newly started decorative descendant rotation is not panel motion.
              const isOwner = target === entry.owner;
              if (!isOwner) {
                const box = target.getBoundingClientRect();
                const ownerBox = entry.owner.getBoundingClientRect();
                if (
                  box.width * box.height <
                  ownerBox.width * ownerBox.height * 0.5
                )
                  continue;
              }
              let record = effects.get(animation);
              if (!record) {
                const timing = effect.getTiming();
                const duration = timing.duration;
                const infinite =
                  (timing.iterations === Number.POSITIVE_INFINITY &&
                    duration !== 0) ||
                  duration === Number.POSITIVE_INFINITY;
                const finite =
                  typeof duration === "number" && Number.isFinite(duration);
                const transition = "transitionProperty" in animation;
                const cssAnimation = "animationName" in animation;
                record = {
                  kind: transition
                    ? "transition"
                    : cssAnimation
                      ? "animation"
                      : "web-animation",
                  property: transition
                    ? String(animation.transitionProperty)
                    : properties.sort().join(","),
                  name: cssAnimation ? String(animation.animationName) : "",
                  durationMs: !infinite && finite ? duration : null,
                  timing: infinite
                    ? "infinite"
                    : finite
                      ? "finite"
                      : "unsupported",
                  delayMs:
                    typeof timing.delay === "number" &&
                    Number.isFinite(timing.delay)
                      ? timing.delay
                      : 0,
                  started: false,
                  canceled: false,
                };
                effects.set(animation, record);
                const captured = record;
                const canceled = () => {
                  captured.canceled = true;
                };
                animation.addEventListener("cancel", canceled);
                animationCleanup.push(() =>
                  animation.removeEventListener("cancel", canceled),
                );
                entry.effects.push(record);
              }
              const computed = effect.getComputedTiming();
              const progress = computed.progress;
              if (
                progress !== null &&
                typeof computed.localTime === "number" &&
                computed.localTime >= Math.max(0, record.delayMs) &&
                !animation.pending &&
                (animation.playState === "running" ||
                  animation.playState === "finished")
              )
                record.started = true;
            }
          };
          const take = () => {
            discover();
            scanEffects();
            for (const entry of entries.values()) {
              const current = sample(entry.element);
              for (const key of diff(entry.before, current))
                entry.changed.add(key);
              const last = entry.samples.at(-1);
              if (current && (!last || diff(last, current).length > 0))
                entry.samples.push(current);
              // A bounded history is enough to establish progressive motion, not frame timing.
              if (entry.samples.length > 30) entry.samples.splice(1, 1);
            }
          };
          const eventNames = [
            "transitionrun",
            "transitionstart",
            "transitionend",
            "transitioncancel",
            "animationstart",
            "animationend",
            "animationcancel",
          ];
          const onEvent = (event: Event) => {
            take();
            if (!(event.target instanceof Element)) return;
            const entry = entries.get(event.target);
            if (!entry) return;
            const property =
              "propertyName" in event ? String(event.propertyName) : undefined;
            const name =
              "animationName" in event
                ? String(event.animationName)
                : undefined;
            for (const record of entry.effects) {
              if (
                (property && record.property !== property) ||
                (name && record.name !== name)
              )
                continue;
              if (
                /start$|end$/.test(event.type) &&
                [...effects].some(
                  ([animation, known]) =>
                    known === record &&
                    animation.playState !== "paused" &&
                    animation.playState !== "idle",
                )
              )
                record.started = true;
              if (/cancel$/.test(event.type)) record.canceled = true;
            }
          };
          for (const name of eventNames)
            document.addEventListener(name, onEvent, true);
          const observer = new MutationObserver(take);
          observer.observe(document, {
            subtree: true,
            childList: true,
            attributes: true,
          });
          let frame = 0;
          const tick = () => {
            take();
            frame = requestAnimationFrame(tick);
          };
          frame = requestAnimationFrame(tick);
          const dispose = () => {
            observer.disconnect();
            cancelAnimationFrame(frame);
            for (const cleanup of animationCleanup) cleanup();
            for (const name of eventNames)
              document.removeEventListener(name, onEvent, true);
            delete scope.__idiomMotion;
          };
          scope.__idiomMotion = {
            token,
            dispose,
            finish: () => {
              take();
              const changes: MotionChange[] = [];
              const progressive = (entry: Entry) => {
                if (baselineTargets.has(entry.element)) return false;
                // Three distinct rendered samples of the same dimension/opacity prove
                // JS motion without claiming its wall time is a configured duration.
                return ["width", "height", "x", "y", "opacity"].some((key) => {
                  const values = entry.samples
                    .filter((s) => s.rendered)
                    .map((s) =>
                      key === "opacity"
                        ? s.opacity
                        : s.rect[key as keyof MotionSample["rect"]],
                    );
                  const tolerance = key === "opacity" ? 0.001 : 0.5;
                  const distinct: number[] = [];
                  for (const value of values)
                    if (
                      distinct.every(
                        (other) => Math.abs(value - other) > tolerance,
                      )
                    )
                      distinct.push(value);
                  return distinct.length >= 3;
                });
              };
              for (const entry of entries.values()) {
                const after = sample(entry.element);
                const changed = [
                  ...new Set([...entry.changed, ...diff(entry.before, after)]),
                ];
                if (changed.length === 0 && entry.effects.length === 0)
                  continue;
                const surface =
                  entry.element === entry.owner &&
                  entry.owner.matches(surfaces);
                const tooltip = entry.owner.matches("[role=tooltip]");
                const ownToggle = changed.some((key) =>
                  ["size", "opacity", "presence", "transform"].includes(key),
                );
                const causal =
                  !entry.before ||
                  !after ||
                  entry.before.state !== after.state ||
                  controls.includes(entry.element.id) ||
                  entry.element === trigger ||
                  entry.element.contains(trigger) ||
                  (triggerState !==
                    (trigger ? sample(trigger)?.state : undefined) &&
                    controls.includes(entry.owner.id));
                const visual = [...entries.values()].filter(
                  (other) =>
                    other.owner === entry.owner &&
                    (other.element === entry.owner ||
                      other.element.contains(entry.owner) ||
                      (() => {
                        const box =
                          other.before?.rect ?? sample(other.element)?.rect;
                        const ownerBox =
                          entries.get(entry.owner)?.before?.rect ??
                          sample(entry.owner)?.rect;
                        return (
                          box &&
                          ownerBox &&
                          box.width * box.height >=
                            ownerBox.width * ownerBox.height * 0.5
                        );
                      })()),
                );
                const actual = visual.some(
                  (other) =>
                    other.effects.some((e) => e.started) || progressive(other),
                );
                const js =
                  actual &&
                  !visual.some((other) => other.effects.some((e) => e.started));
                const before = entry.before;
                const wasOpen =
                  before?.rendered === true && before.opacity > 0.001;
                const isOpen =
                  after?.rendered === true && after.opacity > 0.001;
                const shrinking =
                  before &&
                  after &&
                  (after.rect.width < before.rect.width - 0.5 ||
                    after.rect.height < before.rect.height - 0.5 ||
                    after.opacity < before.opacity - 0.001);
                changes.push({
                  selector: entry.selector,
                  name: entry.name,
                  role: entry.element.getAttribute("role") ?? "",
                  tag: entry.element.tagName.toLowerCase(),
                  ownerSelector: entry.ownerSelector,
                  ownerName: entry.ownerName,
                  surface,
                  tooltip,
                  before,
                  after,
                  changed,
                  toggled: surface && ownToggle && causal,
                  direction:
                    wasOpen && (!isOpen || shrinking)
                      ? "collapse"
                      : !wasOpen && isOpen
                        ? "expand"
                        : shrinking
                          ? "collapse"
                          : "change",
                  animated: actual,
                  ...(js
                    ? {
                        reason:
                          "progressive geometry/opacity motion; duration unavailable",
                      }
                    : {}),
                  effects: entry.effects,
                });
              }
              dispose();
              return {
                ...identity,
                status: notes.length ? "partial" : "ran",
                ...(notes.length ? { reason: notes.join("; ") } : {}),
                changes,
              };
            },
          };
          return matchMedia("(prefers-reduced-motion: reduce)").matches;
        },
        { identity, selectors: this.selectors, token },
      );
    } catch (error) {
      failure = `motion instrumentation unavailable: ${String(error).split("\n")[0]}`;
    }
    let finishing: Promise<void> | undefined;
    const dispose = async () => {
      await this.page
        .evaluate((token) => {
          const active = (window as BrowserWindow).__idiomMotion;
          if (active?.token === token) active.dispose();
        }, token)
        .catch(() => undefined);
    };
    return {
      finish: (reason) => {
        if (finishing) return finishing;
        finishing = (async () => {
          try {
            if (failure) throw new Error(failure);
            // Two rendering opportunities also cover waitMs=0 and queued style changes.
            await this.page.evaluate(
              () =>
                new Promise<void>((resolve) =>
                  requestAnimationFrame(() =>
                    requestAnimationFrame(() => resolve()),
                  ),
                ),
            );
            const action = await this.page.evaluate((token) => {
              const active = (window as BrowserWindow).__idiomMotion;
              if (active?.token !== token) return null;
              return active.finish();
            }, token);
            if (!action)
              throw new Error("document navigation invalidated motion window");
            if (reason) {
              action.status = "partial";
              action.reason = reason;
              for (const change of action.changes)
                if (!change.animated) {
                  change.animated = null;
                  change.reason = reason;
                }
            }
            this.actions.push(linkRecording(action, recording));
          } catch (error) {
            this.actions.push({
              ...identity,
              status: "unavailable",
              reason: String(error).split("\n")[0],
              changes: [],
            });
          } finally {
            await dispose();
          }
        })();
        return finishing;
      },
      dispose,
    };
  }

  evidence(reason?: string): MotionArtifact {
    const incomplete = this.actions.filter((action) => action.status !== "ran");
    const reasons = [
      ...new Set([
        ...(reason ? [reason] : []),
        ...incomplete
          .map((action) => action.reason)
          .filter((r): r is string => !!r),
      ]),
    ];
    return {
      version: 1,
      status:
        this.actions.length === 0 ||
        this.actions.every((a) => a.status === "unavailable")
          ? "unavailable"
          : reasons.length
            ? "partial"
            : "ran",
      reducedMotion: this.reducedMotion,
      actions: [...this.actions],
      ...(reasons.length
        ? { reason: reasons.join("; ") }
        : this.actions.length === 0
          ? {
              reason:
                "no measured actions; enable the interaction probe or declare web steps (recapture)",
            }
          : {}),
    };
  }
}

export function mergeMotion(
  ...artifacts: Array<MotionArtifact | undefined>
): MotionArtifact | undefined {
  const present = artifacts.filter((a): a is MotionArtifact => a !== undefined);
  if (present.length === 0) return undefined;
  const reasons = present.flatMap((a) => (a.reason ? [a.reason] : []));
  return {
    version: 1,
    reducedMotion: present[0]?.reducedMotion ?? false,
    status: present.every((a) => a.status === "unavailable")
      ? "unavailable"
      : present.some((a) => a.status !== "ran")
        ? "partial"
        : "ran",
    ...(reasons.length ? { reason: [...new Set(reasons)].join("; ") } : {}),
    actions: present.flatMap((a) => a.actions),
  };
}
