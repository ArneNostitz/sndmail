import { parseSearchQuery } from "@/services/search/searchParser";

function uniqueTerms(terms: string[]): string[] {
  const seen = new Set<string>();
  return terms.filter((term) => {
    const normalized = term.trim().toLocaleLowerCase();
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function textTerms(value: string): string[] {
  return (value.match(/"[^"]+"|\S+/g) ?? []).map((term) =>
    term.replace(/^"|"$/g, "").trim(),
  );
}

/** Terms that can match message body text. Search operators are intentionally excluded. */
export function getBodySearchTerms(query: string): string[] {
  return uniqueTerms(textTerms(parseSearchQuery(query).freeText));
}

/** Visible row fields include sender and subject, so their operator values can be highlighted too. */
export function getListSearchTerms(query: string): string[] {
  const parsed = parseSearchQuery(query);
  return uniqueTerms([
    ...textTerms(parsed.freeText),
    ...(parsed.from ? [parsed.from] : []),
    ...(parsed.subject ? [parsed.subject] : []),
  ]).sort((a, b) => b.length - a.length);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface HighlightSegment {
  text: string;
  matched: boolean;
}

export function splitSearchMatches(
  text: string,
  terms: readonly string[],
): HighlightSegment[] {
  const normalizedTerms = uniqueTerms([...terms]).sort((a, b) => b.length - a.length);
  if (!text || normalizedTerms.length === 0) {
    return [{ text, matched: false }];
  }

  const matches = new Set(normalizedTerms.map((term) => term.toLocaleLowerCase()));
  const parts = text.split(
    new RegExp(`(${normalizedTerms.map(escapeRegExp).join("|")})`, "gi"),
  );
  return parts
    .filter(Boolean)
    .map((part) => ({
      text: part,
      matched: matches.has(part.toLocaleLowerCase()),
    }));
}

/** Wrap matching text nodes without reparsing or weakening the sanitized email HTML. */
export function highlightSearchTerms(
  root: HTMLElement,
  terms: readonly string[],
): number {
  if (terms.length === 0) return 0;
  const view = root.ownerDocument.defaultView;
  if (!view) return 0;

  const walker = root.ownerDocument.createTreeWalker(
    root,
    view.NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!node.textContent?.trim() || parent?.closest("mark, script, style, textarea, noscript, svg")) {
          return view.NodeFilter.FILTER_REJECT;
        }
        return view.NodeFilter.FILTER_ACCEPT;
      },
    },
  );
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);

  let count = 0;
  for (const node of nodes) {
    const segments = splitSearchMatches(node.data, terms);
    if (!segments.some((segment) => segment.matched)) continue;
    const fragment = root.ownerDocument.createDocumentFragment();
    for (const segment of segments) {
      if (segment.matched) {
        const mark = root.ownerDocument.createElement("mark");
        mark.dataset.sndSearchMatch = "true";
        mark.textContent = segment.text;
        fragment.append(mark);
        count++;
      } else {
        fragment.append(root.ownerDocument.createTextNode(segment.text));
      }
    }
    node.replaceWith(fragment);
  }
  return count;
}
