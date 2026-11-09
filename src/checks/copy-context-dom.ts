import type { Page } from "playwright";
import { copyQuoteRanges } from "./copy-quotes.js";

type Segment = { text: string; quoted: boolean };
export type CopyContextWindow = Window & {
  __idiomCopyQuoteRanges?: typeof copyQuoteRanges;
  __idiomCopyContext?: (
    elements: readonly Element[],
  ) => WeakMap<Element, Segment[]>;
};

// Serialized by Playwright. The single pure quote grammar is installed first.
export function installCopyContextDom(): void {
  (window as CopyContextWindow).__idiomCopyContext = (elements) => {
    const parse = (window as CopyContextWindow).__idiomCopyQuoteRanges;
    if (!parse) throw new Error("copy quotation parser is not installed");
    const owners = new WeakMap<Text, Segment[]>();
    const blocks = new WeakMap<Element, Element>();
    const boundary = (element: Element): boolean =>
      /^(?:a|button|label|option|textarea)$/.test(element.localName) ||
      !["inline", "contents", ""].includes(getComputedStyle(element).display);
    const blockFor = (element: Element): Element => {
      const known = blocks.get(element);
      if (known) return known;
      const block =
        boundary(element) || !element.parentElement
          ? element
          : blockFor(element.parentElement);
      blocks.set(element, block);
      return block;
    };
    let run: Text[] = [];
    let block: Element | undefined;
    const flush = () => {
      if (!run.length) return;
      const text = run.map((node) => node.data).join("");
      const ranges = parse(text);
      let offset = 0;
      for (const node of run) {
        const end = offset + node.length;
        const semantic = node.parentElement?.closest("q, blockquote") !== null;
        const boundaries = [
          ...new Set([
            offset,
            end,
            ...ranges
              .flatMap((range) => [range.start, range.end])
              .filter((point) => point > offset && point < end),
          ]),
        ].sort((a, b) => a - b);
        owners.set(
          node,
          boundaries.slice(0, -1).map((start, index) => ({
            text: text.slice(start, boundaries[index + 1]),
            quoted:
              semantic ||
              ranges.some((range) => start >= range.start && start < range.end),
          })),
        );
        offset = end;
      }
      run = [];
    };
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
    );
    for (
      let current = walker.nextNode();
      current;
      current = walker.nextNode()
    ) {
      const node = current as Text;
      if (!node.parentElement) continue;
      const next = blockFor(node.parentElement);
      if (next !== block) flush();
      block = next;
      run.push(node);
    }
    flush();
    const result = new WeakMap<Element, Segment[]>();
    for (const element of elements) {
      const segments: Segment[] = [];
      let separate = true;
      for (const node of element.childNodes) {
        if (node.nodeType !== Node.TEXT_NODE) {
          // Even an omitted inline code child must separate its adjacent words.
          if (
            (node.textContent ?? "").trim() ||
            (node instanceof Element && node.localName === "br")
          )
            separate = true;
          continue;
        }
        for (const segment of owners.get(node as Text) ?? []) {
          const previous = segments.at(-1);
          if (!separate && previous && previous.quoted === segment.quoted)
            previous.text += segment.text;
          else segments.push({ ...segment });
          separate = false;
        }
      }
      if (segments.length) result.set(element, segments);
    }
    return result;
  };
}

export async function ensureCopyContextDom(page: Page): Promise<void> {
  await page.evaluate(
    `window.__idiomCopyQuoteRanges = (${copyQuoteRanges.toString()})`,
  );
  await page.evaluate(installCopyContextDom);
}
