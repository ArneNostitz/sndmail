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
];

/** Selectors used to wrap a signature. */
const SIGNATURE_SELECTORS = [
  ".gmail_signature",
  "[data-smartmail='gmail_signature']",
  "div.moz-signature",
  "signature",
  "[data-sndmail-signature]",
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

// Header labels used by Outlook, Apple Mail, Thunderbird and several IMAP
// clients when they paste a previous message without a blockquote. These are
// deliberately paired and counted; removing every line beginning with
// "From:" would destroy perfectly legitimate new content.
const HEADER_LABELS = {
  from: /(?:^|\s)(?:von|from):/i,
  to: /(?:^|\s)(?:an|to|cc):/i,
  date: /(?:^|\s)(?:datum|date|gesendet|sent):/i,
  subject: /(?:^|\s)(?:betreff|subject):/i,
};

const REPLY_LEAD = /^(?:dear|hi|hello|hallo|liebe?r|guten\s+(?:morgen|tag|abend)|sehr\s+geehrte)/i;
const HEADER_START = /^(?:von|from|an|to|cc|datum|date|gesendet|sent|betreff|subject):/i;

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

  // Some clients paste a complete reply header as ordinary divs/table rows
  // and then append the old body without any quote markup. This is common in
  // Outlook/Apple Mail exports ("Von/An/Datum/Betreff") and is the reason a
  // simple blockquote-only trim still leaves a lot of old mail visible.
  if (cutAtUnwrappedHeaders(body)) removed = true;

  // A few clients omit both the quote wrapper and the header, leaving only a
  // horizontal rule before the previous message. Treat it as quoted material
  // only when the following content looks like a mail opening and contains
  // multiple blocks, keeping ordinary visual dividers in new mail safe.
  if (cutAtQuotedSeparator(body)) removed = true;

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

function headerScore(text: string): { score: number; hasFrom: boolean; hasTo: boolean; hasDate: boolean; hasSubject: boolean } {
  const normalized = text.replace(/[\u00a0\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  const hasFrom = HEADER_LABELS.from.test(normalized);
  const hasTo = HEADER_LABELS.to.test(normalized);
  const hasDate = HEADER_LABELS.date.test(normalized);
  const hasSubject = HEADER_LABELS.subject.test(normalized);
  return { score: [hasFrom, hasTo, hasDate, hasSubject].filter(Boolean).length, hasFrom, hasTo, hasDate, hasSubject };
}

function cutAtUnwrappedHeaders(body: HTMLElement): boolean {
  const candidates = Array.from(body.querySelectorAll("div, p, section, table, tbody, tr, td, th, li"));
  for (const candidate of candidates) {
    const ownText = readableElementText(candidate);
    const own = headerScore(ownText);
    if (own.score >= 3 && own.hasFrom && own.hasTo && (own.hasDate || own.hasSubject) && HEADER_START.test(ownText.trim())) {
      removeFromNode(candidate);
      return true;
    }

    // Header labels may be split into separate sibling rows. Look ahead only
    // within the same small region so normal mail containing header-like
    // words in distant paragraphs is not treated as quoted mail.
    const siblings = Array.from(candidate.parentElement?.children ?? []);
    const index = siblings.indexOf(candidate);
    if (index < 0) continue;
    if (own.score === 0 || !HEADER_START.test(ownText.trim())) continue;
    const windowText = siblings.slice(index, index + 6).map(readableElementText).join(" ");
    const windowScore = headerScore(windowText);
    if (windowScore.score >= 3 && windowScore.hasFrom && windowScore.hasTo && (windowScore.hasDate || windowScore.hasSubject)) {
      removeFromNode(candidate);
      return true;
    }
  }
  return false;
}

function readableElementText(element: Element): string {
  // textContent collapses <br>-separated header fields into one word in
  // browser DOMs ("matchmii.comAn:"). Put structural breaks back before
  // applying the label recognizer.
  return element.innerHTML
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:div|p|section|tr|td|th|li)>/gi, "\n")
    .replace(/<[^>]*>/g, " ");
}

function cutAtQuotedSeparator(body: HTMLElement): boolean {
  for (const separator of Array.from(body.querySelectorAll("hr"))) {
    const following = followingElements(separator);
    const firstText = following.map((node) => (node.textContent ?? "").trim()).find(Boolean) ?? "";
    const followingText = following.map((node) => node.textContent ?? "").join(" ").trim();
    if (following.length >= 2 && followingText.length >= 40 && REPLY_LEAD.test(firstText)) {
      removeFromNode(separator);
      return true;
    }
  }
  return false;
}

function followingElements(node: Element): Element[] {
  const elements: Element[] = [];
  let current: Node | null = node;
  while (current?.parentNode) {
    let sibling = current.nextSibling;
    while (sibling) {
      if (sibling.nodeType === Node.ELEMENT_NODE) elements.push(sibling as Element);
      sibling = sibling.nextSibling;
    }
    current = current.parentNode;
  }
  return elements;
}

/** Remove this node and every later node, while retaining earlier body text. */
function removeFromNode(node: Node): void {
  let current: Node | null = node;
  while (current?.parentNode) {
    let sibling = current.nextSibling;
    while (sibling) {
      const next = sibling.nextSibling;
      sibling.parentNode?.removeChild(sibling);
      sibling = next;
    }
    const parent: Node = current.parentNode;
    parent.removeChild(current);
    if (parent === node.ownerDocument?.body) return;
    // The wrapper still contains the new message before the removed node.
    // Keep that wrapper; climbing further would delete the entire message.
    if (parent.firstChild) return;
    current = parent;
  }
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
    const currentHeader = Object.values(HEADER_LABELS).some((pattern) => pattern.test(line));
    if (!currentHeader) continue;
    const headerWindow = lines.slice(i, i + 6).join(" ");
    const header = headerScore(headerWindow);
    if (header.score >= 3 && header.hasFrom && header.hasTo && (header.hasDate || header.hasSubject)) {
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
