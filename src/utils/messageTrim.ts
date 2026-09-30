/**
 * Reduce a mail body to what the sender actually wrote.
 *
 * Mail clients keep appending: the quoted message being replied to, a
 * signature, a legal footer, an "On <date>, <name> wrote:" line, "Sent from
 * my iPhone". In a conversation view every one of those is text the reader
 * has already seen a screen earlier, so the message shows only the new part
 * and offers "View full" for the original.
 *
 * A message that turns out to be nothing but quoted material — a bare
 * forward — is reported as empty rather than being handed back untrimmed, so
 * the caller can say "forwarded an email" instead of pasting the whole
 * newsletter into the conversation.
 */

export interface TrimResult {
  /** Body with quotes, signatures and footers removed. */
  html: string | null;
  text: string | null;
  /** True when anything was actually removed. */
  trimmed: boolean;
  /**
   * True when nothing readable is left. With `trimmed` it means the message
   * carried no words of its own — a forward, or a reply that is only a quote.
   */
  empty: boolean;
}

/**
 * Selectors used by the major clients to wrap a quoted message.
 * Gmail, Apple Mail, Outlook, Thunderbird, Yahoo and the generic RFC form.
 */
const QUOTE_SELECTORS = [
  "blockquote",
  ".gmail_quote",
  ".gmail_extra",
  ".gmail_attr",
  "div.yahoo_quoted",
  "div.moz-cite-prefix",
  "#divRplyFwdMsg",
  "div[id^='divRplyFwdMsg']",
  "hr#stopSpelling",
  "[data-sndmail-quote]",
  "[data-velo-quote]",
];

/** Selectors used to wrap a signature. */
const SIGNATURE_SELECTORS = [
  ".gmail_signature",
  "[data-smartmail='gmail_signature']",
  "div.moz-signature",
  "signature",
  "[data-sndmail-signature]",
  "[data-velo-signature]",
];

/**
 * Everything from here on is quoted mail or a signature.
 *
 * Matched at the start of a text node, not anywhere inside one: an
 * attribution line is always its own paragraph or the opening of a quote
 * block, so anchoring it keeps a sentence like "he wrote: ..." in the middle
 * of real prose out of the net.
 */
const CUT_PATTERNS: RegExp[] = [
  // "On Tue, Sep 1, 2026 at 23:27, Arne wrote:" — the quoted body often
  // follows in the same node, so the match does not have to end the line
  /^On\s[\s\S]{6,240}?\bwrote:/i,
  /^Am\s[\s\S]{6,240}?\bschrieb[^:]{0,140}:/i,
  /^Le\s[\s\S]{6,240}?\ba écrit\s*:/i,
  /^El\s[\s\S]{6,240}?\bescribió:/i,
  // Outlook / Apple Mail forward and reply headers
  /^-{2,}\s*Original Message\s*-{2,}/i,
  /^-{2,}\s*Forwarded message\s*-{2,}/i,
  /^-{3,}\s*Urspr(ü|ue)ngliche Nachricht\s*-{3,}/i,
  /^_{10,}/,
  // Mobile client footers
  /^Sent from my \w+/i,
  /^Gesendet von meinem \w+/i,
  /^Von meinem i(Phone|Pad) gesendet/i,
  /^Envoyé de mon \w+/i,
  /^Get Outlook for \w+/i,
  // The classic signature separator
  /^--\s*$/,
];

/** A line that opens a signature block in plain text. */
const SIGNATURE_SEPARATOR = /^--\s?$/;

/**
 * Drop quoted mail and signatures from an HTML body.
 *
 * Runs on a detached document, so nothing here loads resources or executes
 * scripts — the caller still sanitises before rendering.
 */
export function trimHtmlBody(html: string): { html: string; trimmed: boolean; empty: boolean } {
  if (typeof DOMParser === "undefined") {
    return { html, trimmed: false, empty: false };
  }

  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, "text/html");
  } catch {
    return { html, trimmed: false, empty: false };
  }
  const body = doc.body;
  if (!body) return { html, trimmed: false, empty: false };

  const before = hasContent(body);
  let removed = false;

  const removeAll = (selectors: string[]) => {
    for (const selector of selectors) {
      let nodes: NodeListOf<Element>;
      try {
        nodes = body.querySelectorAll(selector);
      } catch {
        // An invalid selector must not take the whole trim down with it
        continue;
      }
      for (const node of Array.from(nodes)) {
        // A quote nested inside an already-removed quote is gone already
        if (!node.isConnected) continue;
        node.remove();
        removed = true;
      }
    }
  };

  removeAll(QUOTE_SELECTORS);
  removeAll(SIGNATURE_SELECTORS);

  // Attribution lines and mobile footers usually sit *outside* the block they
  // introduce, so removing the quote leaves them dangling
  removed = cutAtAttribution(body) || removed;

  if (!removed) return { html, trimmed: false, empty: !before };

  return { html: body.innerHTML, trimmed: true, empty: !hasContent(body) };
}

/**
 * Characters that occupy no space but defeat an "is this empty" check:
 * zero-width spaces and joiners, the combining grapheme joiner, soft hyphens
 * and the BOM. Newsletters pack hundreds of them into the preheader.
 */
const INVISIBLE = /[\u00ad\u034f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\ufeff]/g;

/** Whether an element still shows the reader anything. */
function hasContent(root: HTMLElement): boolean {
  if ((root.textContent ?? "").replace(INVISIBLE, "").replace(/\u00a0/g, " ").trim() !== "") return true;
  return !!root.querySelector("img, video, audio, iframe, table");
}

/**
 * Find the first text node that opens with quoted material and cut the
 * document there — truncating that node and dropping everything after it in
 * document order.
 */
function cutAtAttribution(body: HTMLElement): boolean {
  const walker = body.ownerDocument.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode() as Text | null;

  while (node) {
    const raw = node.data;
    const lead = raw.length - raw.replace(/^[\s\u00a0\ufeff]+/, "").length;
    const rest = raw.slice(lead);
    if (rest && CUT_PATTERNS.some((p) => p.test(rest))) {
      node.data = raw.slice(0, lead);
      removeEverythingAfter(node);
      return true;
    }
    node = walker.nextNode() as Text | null;
  }
  return false;
}

/** Detach every node that follows `node` in document order. */
function removeEverythingAfter(node: Node): void {
  let current: Node | null = node;
  while (current && current.parentNode) {
    let sibling = current.nextSibling;
    while (sibling) {
      const next = sibling.nextSibling;
      sibling.parentNode?.removeChild(sibling);
      sibling = next;
    }
    current = current.parentNode;
  }
}

/** Drop quoted lines, attribution lines and signatures from a plain-text body. */
export function trimTextBody(text: string): { text: string; trimmed: boolean; empty: boolean } {
  const lines = text.split(/\r?\n/);
  let cut = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (SIGNATURE_SEPARATOR.test(line) || CUT_PATTERNS.some((p) => p.test(line))) {
      cut = i;
      break;
    }
    // A run of ">" quoting with nothing but quotes after it
    if (line.startsWith(">") && lines.slice(i).every((l) => {
      const t = l.trim();
      return t === "" || t.startsWith(">");
    })) {
      cut = i;
      break;
    }
  }

  if (cut === lines.length) return { text, trimmed: false, empty: text.trim() === "" };
  const kept = lines.slice(0, cut).join("\n").trimEnd();
  return { text: kept, trimmed: true, empty: kept.trim() === "" };
}

/**
 * Trim whichever body a message actually has, preferring HTML.
 */
export function trimMessageBody(
  html: string | null,
  text: string | null,
): TrimResult {
  if (html) {
    const result = trimHtmlBody(html);
    return {
      html: result.html,
      text: result.empty ? null : text,
      trimmed: result.trimmed,
      empty: result.empty,
    };
  }
  if (text) {
    const result = trimTextBody(text);
    return { html: null, text: result.text, trimmed: result.trimmed, empty: result.empty };
  }
  return { html, text, trimmed: false, empty: true };
}

/**
 * A single line of the trimmed body, for a folded message.
 *
 * The stored snippet is the provider's, taken from the untrimmed mail, so it
 * happily previews a quote the reader has already seen — which is exactly
 * what a folded message must not show.
 */
export function previewText(result: TrimResult): string {
  const source = result.html ?? result.text ?? "";
  if (!source) return "";
  let plain = source;
  if (result.html && typeof DOMParser !== "undefined") {
    try {
      plain = new DOMParser().parseFromString(source, "text/html").body?.textContent ?? "";
    } catch {
      plain = source;
    }
  }
  return plain.replace(INVISIBLE, "").replace(/[\s\u00a0]+/g, " ").trim();
}
