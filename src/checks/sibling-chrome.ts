import { isVisuallyHidden, ran, signalledElements, verify } from "./shared.js";
import type {
  CheckTuple,
  DeterministicCheck,
  FindingCandidate,
} from "./types.js";

type Control = { selector: string; role: string; name: string };

type Region = {
  /** The first rendered match, or undefined when the selector matched nothing. */
  root?: string | undefined;
  controls: Map<string, Control>;
};

type Inventory = Map<string, Region> | { reason: string };

const inventories = new WeakMap<CheckTuple, Inventory>();

const normalise = (value: string) =>
  value.replace(/\s+/g, " ").trim().toLowerCase();

/** Named controls inside each configured chrome region of one tuple. */
function inventory(tuple: CheckTuple, regions: readonly string[]): Inventory {
  const cached = inventories.get(tuple);
  if (cached !== undefined) return cached;
  const result = ((): Inventory => {
    const signalled = signalledElements(tuple);
    if ("reason" in signalled) return signalled;
    const observation = tuple.observations;
    const marks =
      observation?.version === 2 ? (observation.selectorMarks ?? []) : [];
    const map: Map<string, Region> = new Map();
    for (const selector of regions) {
      const mark = marks.find(
        (entry) =>
          entry.purpose === "sibling-region" && entry.selector === selector,
      );
      if (mark === undefined)
        return {
          reason: `${selector} was not resolved at capture (recapture)`,
        };
      if (mark.invalid)
        return { reason: `${selector} is not a valid selector` };
      const roots = new Set(mark.matches);
      const controls = new Map<string, Control>();
      for (const element of signalled.elements) {
        if (!element.interactive || isVisuallyHidden(element)) continue;
        if (
          !roots.has(element.selector) &&
          !element.ancestorSelectors.some((ancestor) => roots.has(ancestor))
        )
          continue;
        const name = (
          element.signals.name ||
          element.signals.title ||
          element.attributes["aria-label"] ||
          ""
        ).trim();
        if (name === "") continue;
        const role = element.signals.role;
        const key = `${role}\u0000${normalise(name)}`;
        if (!controls.has(key))
          controls.set(key, { selector: element.selector, role, name });
      }
      map.set(selector, { root: mark.matches[0], controls });
    }
    return map;
  })();
  inventories.set(tuple, result);
  return result;
}

function listStates(states: string[]): string {
  const shown = states.slice(0, 6).join(", ");
  return states.length > 6 ? `${shown} and ${states.length - 6} more` : shown;
}

/**
 * Persistent chrome across declared sibling states (dogfooding request #72):
 * a named control every sibling shows inside a chrome region, missing from
 * one of them.
 */
export const siblingChromeCheck: DeterministicCheck = {
  id: "sibling-chrome",
  run({ tuple, config, tuples }) {
    const regions = config.siblingChrome.regions;
    const skipped = (reason: string) => ({
      coverage: { check: this.id, status: "skipped" as const, reason },
      candidates: [],
    });
    if (regions.length === 0)
      return skipped("checks.siblingChrome.regions is empty");
    if (tuple.siblings === undefined)
      return skipped("state declares no siblingGroup/group");
    const own = inventory(tuple, regions);
    if (!(own instanceof Map))
      return {
        coverage: { check: this.id, status: "unavailable", reason: own.reason },
        candidates: [],
      };
    const peers = (tuples ?? []).flatMap((other) => {
      if (
        other === tuple ||
        other.siblings !== tuple.siblings ||
        other.viewport !== tuple.viewport ||
        other.colorScheme !== tuple.colorScheme ||
        other.failure !== undefined ||
        other.observations === undefined
      )
        return [];
      const regionsOf = inventory(other, regions);
      return regionsOf instanceof Map ? [{ tuple: other, regionsOf }] : [];
    });
    if (peers.length < 2)
      return skipped(
        `fewer than 2 sibling states share ${tuple.siblings} at this viewport`,
      );
    const candidates: FindingCandidate[] = [];
    const notes: string[] = [];
    const presentIn = [...new Set(peers.map((peer) => peer.tuple.state))];
    for (const selector of regions) {
      const mine = own.get(selector);
      const [first, ...rest] = peers.map((peer) =>
        peer.regionsOf.get(selector),
      );
      if (mine === undefined || first === undefined) continue;
      for (const [key, control] of first.controls) {
        if (!rest.every((region) => region?.controls.has(key))) continue;
        if (mine.controls.has(key)) continue;
        if (mine.root === undefined) {
          notes.push(`${selector} matched nothing in "${tuple.state}"`);
          break;
        }
        candidates.push({
          category: this.id,
          severity: "major",
          rule: "idiom:sibling-chrome-missing",
          selectorHint: mine.root,
          fingerprintHint: `sibling:${tuple.siblings}|${selector}|${control.role}|${normalise(control.name)}`,
          explanation: `State "${tuple.state}" lacks the ${control.role} "${control.name}" in ${selector} that its ${presentIn.length} sibling states (${listStates(presentIn)}) all show.`,
          acceptance: [
            `${selector} in "${tuple.state}" shows the ${control.role} "${control.name}", as in its sibling states.`,
          ],
          verification: verify(this.id, {
            group: tuple.siblings,
            region: selector,
            role: control.role,
            name: control.name,
            presentIn,
            selectorInPeer: control.selector,
          }),
        });
      }
    }
    return notes.length === 0
      ? ran(this.id, candidates)
      : {
          coverage: { check: this.id, status: "ran", reason: notes.join("; ") },
          candidates,
        };
  },
};
