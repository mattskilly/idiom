import { observed } from "../findings/observation.js";
import { verify } from "./shared.js";
import type {
  CollectionAction,
  DeterministicCheck,
  FindingCandidate,
} from "./types.js";

/**
 * Names of buttons that open an item's overflow menu. Shared by capture
 * (observe records triggers) and the probe (which opens them read-only).
 */
export const menuTriggerPattern = /\b(more|options|actions|menu)\b|^[⋯⋮…•·]+$/i;

/** Whole-word, case-insensitive names that offer each action. */
export const actionVocabulary: Record<CollectionAction, RegExp> = {
  open: /\b(open|view|edit)\b/i,
  rename: /\b(rename|edit (name|title|details))\b/i,
  delete: /\b(delete|remove|trash|move to trash|discard)\b/i,
};

function list(names: string[]): string {
  const shown = names.slice(0, 5).join(", ");
  return names.length > 5 ? `${shown}, …` : shown;
}

export const collectionActionsCheck: DeterministicCheck = {
  id: "collection-actions",
  run({ tuple, config }) {
    const declared = config.collections;
    if (declared.length === 0)
      return {
        coverage: {
          check: this.id,
          status: "skipped",
          reason: "no checks.collections declared",
        },
        candidates: [],
      };
    const observation = tuple.observations;
    if (observation?.version !== 2 || observation.collections === undefined)
      return {
        coverage: {
          check: this.id,
          status: "unavailable",
          reason:
            "collections not observed at capture (recapture after adding checks.collections)",
        },
        candidates: [],
      };
    const probe = observation.probe;
    const notes: string[] = [];
    const candidates: FindingCandidate[] = [];
    let examined = 0;
    for (const declaration of declared) {
      const { selector } = declaration;
      const evidence = observation.collections.find(
        (entry) => entry.selector === selector,
      );
      if (evidence === undefined) {
        notes.push(
          `${selector} not resolved at capture (recapture after adding checks.collections)`,
        );
        continue;
      }
      if (evidence.invalid) {
        notes.push(`${selector} is not a valid selector`);
        continue;
      }
      if (evidence.items.length === 0) {
        notes.push(`${selector} matched no rendered items`);
        continue;
      }
      examined += 1;
      const probed = probe?.collections?.find(
        (entry) => entry.selector === selector,
      );
      const menuItems = probed?.menus.flatMap((menu) => menu.items) ?? [];
      const triggers = evidence.items.flatMap((item) => item.menuTriggers);
      const controls = [
        ...new Set(evidence.items.flatMap((item) => item.controls)),
      ];
      const label = declaration.name ?? selector;
      for (const verb of declaration.actions) {
        const pattern = actionVocabulary[verb];
        const reachable =
          evidence.items.some(
            (item) =>
              (verb === "open" && item.open) ||
              item.controls.some((name) => pattern.test(name)),
          ) || menuItems.some((name) => pattern.test(name));
        if (reachable) continue;
        if (
          triggers.length > 0 &&
          (probed === undefined ||
            (probed.menus.length === 0 && probed.reason !== undefined))
        ) {
          notes.push(
            `${selector}: ${triggers.length} menu trigger(s) not probed${probed?.reason ? ` (${probed.reason})` : ""}; enable checks.probe to judge ${verb}`,
          );
          continue;
        }
        const found: string[] = [
          controls.length > 0
            ? `items offer ${list(controls)}`
            : "items offer no named controls",
        ];
        if (probed === undefined)
          found.push("no menu (⋯) trigger; right-click not probed");
        else
          for (const menu of probed.menus)
            found.push(
              menu.trigger === "contextmenu"
                ? menu.items.length > 0
                  ? `right-click lists ${list(menu.items)}`
                  : "right-click opens nothing"
                : menu.items.length > 0
                  ? `menu "${menu.name}" lists ${list(menu.items)}`
                  : `menu "${menu.name}" opens nothing`,
            );
        const first = evidence.items[0] as (typeof evidence.items)[number];
        candidates.push({
          ...(probed === undefined
            ? {}
            : {
                observation: observed(
                  {
                    source: "collection-probe",
                    kind: "menu/contextmenu",
                    selector,
                    name: verb,
                  },
                  probed,
                  probed.elapsedMs === undefined
                    ? undefined
                    : { elapsedMs: probed.elapsedMs },
                ),
              }),
          documentScope: true,
          category: this.id,
          severity: "minor",
          rule: "idiom:collection-actions",
          selectorHint: first.selector,
          fingerprintHint: `collection-actions:${selector}:${verb}`,
          explanation: `Heuristic: no way to ${verb} ${label} items was found: ${found.join("; ")}.`,
          acceptance: [
            `${verb[0]?.toUpperCase()}${verb.slice(1)} is reachable from each ${label} item, its menu or its context menu.`,
          ],
          verification: verify(this.id, {
            selector: first.selector,
            collection: selector,
            verb,
            probed: probed !== undefined,
          }),
        });
      }
    }
    return {
      coverage: {
        check: this.id,
        status:
          examined === 0 && notes.some((note) => note.includes("recapture"))
            ? "unavailable"
            : "ran",
        reason: [`${examined} collections examined`, ...notes].join("; "),
      },
      candidates,
    };
  },
};
