export type EmailDataKind = "url" | "email" | "phone" | "date" | "address" | "app";

export interface EmailDataAction {
  kind: EmailDataKind;
  value: string;
  label: string;
  href?: string;
  startTime?: string;
  endTime?: string;
}

export interface InstrumentedEmailAction {
  action: EmailDataAction;
  rawHref: string;
  resolvedHref: string;
  anchor: HTMLAnchorElement;
}

interface MatchCandidate extends EmailDataAction {
  index: number;
  length: number;
  priority: number;
}

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'\0]+/gi;
const PHONE_RE = /(?:\+\d{1,3}[\s()./-]?)?(?:\d[\s()./-]?){6,14}\d/g;
const ADDRESS_RE = /\b(?:\d{1,5}[A-Za-z/-]*[^\S\r\n]+(?:[\p{L}\d.'-]+[^\S\r\n]+){1,5}(?:Street|St\.?|Road|Rd\.?|Avenue|Ave\.?|Boulevard|Blvd\.?|Lane|Ln\.?|Drive|Dr\.?)|[\p{L}.'-]+(?:straße|strasse|gasse|weg|platz)[^\S\r\n]+\d{1,5}[A-Za-z\d/-]*)\b/giu;
// Only extend a street through a recognizable postal line, never through
// arbitrary neighbouring prose or a table-cell boundary.
const POSTAL_LINE_RE = /^(?:,[^\S\r\n]*|[^\S\r\n]*\r?\n[^\S\r\n]*|[^\S\r\n]+)(?:[\p{L}][\p{L} .'-]{0,60},[^\S\r\n]*[A-Z]{2}[^\S\r\n]+\d{5}(?:-\d{4})?|(?:[A-Z]{1,2}-)?\d{4,5}[^\S\r\n]+[\p{L}][\p{L} '-]{0,60})(?=$|[\s.,;])/u;
const COUNTRY_LINE_RE = /^[^\S\r\n]*\r?\n[^\S\r\n]*(?:United States(?: of America)?|USA|United Kingdom|Austria|Österreich|Germany|Deutschland|Switzerland|Schweiz)(?=$|[\s.,;])/iu;

const MONTHS: Record<string, number> = {
  january: 0, januar: 0,
  february: 1, februar: 1,
  march: 2, märz: 2, maerz: 2,
  april: 3,
  may: 4, mai: 4,
  june: 5, juni: 5,
  july: 6, juli: 6,
  august: 7,
  september: 8,
  october: 9, oktober: 9,
  november: 10,
  december: 11, dezember: 11,
};

const DATE_PATTERNS = [
  /\b(20\d{2})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?\b/g,
  /\b(\d{1,2})\.(\d{1,2})\.(20\d{2})(?:\s+(?:at|um)?\s*(\d{1,2}):(\d{2})(?:\s*(am|pm))?)?\b/gi,
  /\b(January|Januar|February|Februar|March|März|Maerz|April|May|Mai|June|Juni|July|Juli|August|September|October|Oktober|November|December|Dezember)\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+(20\d{2})(?:\s+(?:at|um)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?\b/gi,
  /\b(\d{1,2})(?:st|nd|rd|th)?\.?\s+(January|Januar|February|Februar|March|März|Maerz|April|May|Mai|June|Juni|July|Juli|August|September|October|Oktober|November|December|Dezember)\s+(20\d{2})(?:\s+(?:at|um)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?\b/gi,
];

const SAFE_APP_SCHEMES = new Set([
  "facetime:",
  "facetime-audio:",
  "maps:",
  "msteams:",
  "slack:",
  "sms:",
  "zoommtg:",
]);

function trimUrl(raw: string): string {
  return raw.replace(/[.,;:!?)\]}'"»]+$/g, "");
}

function toLocalInput(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function validDate(year: number, month: number, day: number, hour: number, minute: number): Date | null {
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  const date = new Date(year, month, day, hour, minute, 0, 0);
  if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) return null;
  return date;
}

function dateFromMatch(match: RegExpExecArray, patternIndex: number): Date | null {
  let year: number;
  let month: number;
  let day: number;
  let hour: number;
  let minute: number;
  let meridiem: string | undefined;

  if (patternIndex === 0) {
    year = Number(match[1]);
    month = Number(match[2]) - 1;
    day = Number(match[3]);
    hour = match[4] ? Number(match[4]) : 9;
    minute = match[5] ? Number(match[5]) : 0;
  } else if (patternIndex === 1) {
    day = Number(match[1]);
    month = Number(match[2]) - 1;
    year = Number(match[3]);
    hour = match[4] ? Number(match[4]) : 9;
    minute = match[5] ? Number(match[5]) : 0;
    meridiem = match[6]?.toLowerCase();
  } else if (patternIndex === 2) {
    month = MONTHS[match[1]?.toLowerCase() ?? ""] ?? -1;
    day = Number(match[2]);
    year = Number(match[3]);
    hour = match[4] ? Number(match[4]) : 9;
    minute = match[5] ? Number(match[5]) : 0;
    meridiem = match[6]?.toLowerCase();
  } else {
    day = Number(match[1]);
    month = MONTHS[match[2]?.toLowerCase() ?? ""] ?? -1;
    year = Number(match[3]);
    hour = match[4] ? Number(match[4]) : 9;
    minute = match[5] ? Number(match[5]) : 0;
    meridiem = match[6]?.toLowerCase();
  }

  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  return validDate(year, month, day, hour, minute);
}

function collectMatches(text: string): MatchCandidate[] {
  const matches: MatchCandidate[] = [];

  const add = (match: RegExpExecArray, action: Omit<MatchCandidate, "index" | "length">) => {
    matches.push({ ...action, index: match.index, length: match[0].length });
  };

  URL_RE.lastIndex = 0;
  for (const match of text.matchAll(URL_RE)) {
    const raw = trimUrl(match[0]);
    if (!raw) continue;
    add(match, {
      kind: "url",
      value: raw.startsWith("www.") ? `https://${raw}` : raw,
      label: raw,
      href: raw.startsWith("www.") ? `https://${raw}` : raw,
      priority: 0,
    });
    matches[matches.length - 1]!.length = raw.length;
  }

  EMAIL_RE.lastIndex = 0;
  for (const match of text.matchAll(EMAIL_RE)) {
    add(match, { kind: "email", value: match[0], label: match[0], href: `mailto:${match[0]}`, priority: 1 });
  }

  DATE_PATTERNS.forEach((pattern, patternIndex) => {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const start = dateFromMatch(match, patternIndex);
      if (!start) continue;
      const end = new Date(start.getTime() + 60 * 60 * 1000);
      add(match, {
        kind: "date",
        value: match[0],
        label: match[0],
        startTime: toLocalInput(start),
        endTime: toLocalInput(end),
        priority: 2,
      });
    }
  });

  ADDRESS_RE.lastIndex = 0;
  for (const match of text.matchAll(ADDRESS_RE)) {
    const postal = text.slice(match.index + match[0].length).match(POSTAL_LINE_RE)?.[0] ?? "";
    const country = postal ? text.slice(match.index + match[0].length + postal.length).match(COUNTRY_LINE_RE)?.[0] ?? "" : "";
    const fullAddress = `${match[0]}${postal}${country}`;
    const value = fullAddress.trim().replace(/\s*\n\s*/g, ", ").replace(/[^\S\r\n]+/g, " ");
    add(match, { kind: "address", value, label: value, priority: 3 });
    matches[matches.length - 1]!.length = fullAddress.length;
  }

  PHONE_RE.lastIndex = 0;
  for (const match of text.matchAll(PHONE_RE)) {
    const digits = match[0].replace(/\D/g, "");
    if (digits.length < 7 || digits.length > 15) continue;
    add(match, { kind: "phone", value: match[0].trim(), label: match[0], href: `tel:${match[0].replace(/[^+\d]/g, "")}`, priority: 4 });
  }

  matches.sort((a, b) => a.index - b.index || a.priority - b.priority || b.length - a.length);
  const accepted: MatchCandidate[] = [];
  for (const candidate of matches) {
    const overlaps = accepted.some(
      (existing) => candidate.index < existing.index + existing.length && existing.index < candidate.index + candidate.length,
    );
    if (!overlaps) accepted.push(candidate);
  }
  return accepted.sort((a, b) => a.index - b.index);
}

function createActionAnchor(doc: Document, action: EmailDataAction, text: string): HTMLAnchorElement {
  const anchor = doc.createElement("a");
  anchor.textContent = text;
  anchor.href = action.href ?? "#";
  anchor.dataset.sndmailKind = action.kind;
  anchor.dataset.sndmailValue = action.value;
  if (action.startTime) anchor.dataset.sndmailStart = action.startTime;
  if (action.endTime) anchor.dataset.sndmailEnd = action.endTime;
  anchor.dataset.sndmailTooltip = action.kind === "date" ? "Create calendar event" : `Actions for ${action.label}`;
  return anchor;
}

/** Add safe, typed actions to data that the sender did not already link. */
export function decorateEmailData(doc: Document): void {
  if (!doc.body) return;
  const nodes: Array<{ node: Text; offset: number }> = [];
  let text = "";
  const lineBreak = () => { if (!text.endsWith("\n")) text += "\n"; };
  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      nodes.push({ node: node as Text, offset: text.length });
      text += node.textContent ?? "";
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    if (element.matches("a, button, input, textarea, code, script, style")) {
      text += "\0";
      return;
    }
    const block = element.matches("p, div, address, li, tr, h1, h2, h3, h4, br");
    const cell = element.matches("td, th");
    if (cell) text += "\0";
    if (block) lineBreak();
    for (const child of element.childNodes) walk(child);
    if (block) lineBreak();
    if (cell) text += "\0";
  };
  walk(doc.body);
  const matches = collectMatches(text);

  // Wrap only each text segment, preserving sender markup and line breaks.
  // All segments of a postal address carry the same complete address value.
  for (const { node: textNode, offset } of nodes) {
    const localMatches = matches.filter((match) => match.index < offset + textNode.length && match.index + match.length > offset);
    if (localMatches.length === 0) continue;
    const fragment = doc.createDocumentFragment();
    let cursor = 0;
    for (const match of localMatches) {
      const start = Math.max(0, match.index - offset);
      const end = Math.min(textNode.length, match.index + match.length - offset);
      fragment.append(textNode.data.slice(cursor, start));
      fragment.append(createActionAnchor(doc, match, textNode.data.slice(start, end)));
      cursor = end;
    }
    fragment.append(textNode.data.slice(cursor));
    textNode.replaceWith(fragment);
  }
}

/**
 * Keep ordinary URLs intact. Only dates and addresses need an app action
 * target. The native navigation delegate handles both without email scripts.
 */
export function instrumentEmailActions(
  doc: Document,
  rendererId: string,
): Map<string, InstrumentedEmailAction> {
  const actions = new Map<string, InstrumentedEmailAction>();
  let index = 0;
  for (const anchor of doc.querySelectorAll<HTMLAnchorElement>("a")) {
    if (anchor.dataset.sndmailActionId) continue;
    const action = actionForAnchor(anchor);
    if (!action) continue;
    const actionId = String(index++);
    const rawHref = anchor.getAttribute("href")?.trim() ?? action.href ?? action.value;
    const resolvedHref = action.href ?? anchor.href;
    actions.set(actionId, { action, rawHref, resolvedHref, anchor });
    anchor.dataset.sndmailActionId = actionId;
    if (action.kind === "date" || action.kind === "address") {
      anchor.href = `/__sndmail_email_action__/${encodeURIComponent(rendererId)}/${encodeURIComponent(actionId)}`;
      anchor.target = "_self";
    } else {
      // frame-src 'self' intentionally forbids websites inside the message.
      // A user-activated top navigation reaches the native delegate, which
      // cancels it and opens the destination externally instead.
      anchor.target = "_top";
    }
  }
  return actions;
}

/** Classify both sender-provided anchors and anchors created by decorateEmailData. */
export function actionForAnchor(anchor: HTMLAnchorElement): EmailDataAction | null {
  const kind = anchor.dataset.sndmailKind as EmailDataKind | undefined;
  if (kind) {
    const value = anchor.dataset.sndmailValue;
    return {
      kind,
      value: value ?? anchor.textContent?.trim() ?? "",
      label: kind === "address" ? value ?? "" : anchor.textContent?.trim() || value || "",
      href: anchor.getAttribute("href") ?? undefined,
      startTime: anchor.dataset.sndmailStart,
      endTime: anchor.dataset.sndmailEnd,
    };
  }

  const rawHref = anchor.getAttribute("href")?.trim();
  if (!rawHref || rawHref.startsWith("#")) return null;

  if (/^mailto:/i.test(rawHref)) {
    const value = decodeURIComponent(rawHref.slice(7).split("?")[0] ?? "");
    return { kind: "email", value, label: anchor.textContent?.trim() || value, href: rawHref };
  }
  if (/^(?:tel|sms|facetime|facetime-audio):/i.test(rawHref)) {
    const value = decodeURIComponent(rawHref.slice(rawHref.indexOf(":") + 1).split("?")[0] ?? "");
    return { kind: "phone", value, label: anchor.textContent?.trim() || value, href: rawHref };
  }

  try {
    const url = new URL(rawHref.startsWith("www.") ? `https://${rawHref}` : rawHref);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return { kind: "url", value: url.href, label: anchor.textContent?.trim() || url.href, href: url.href };
    }
    if (SAFE_APP_SCHEMES.has(url.protocol)) {
      return { kind: "app", value: rawHref, label: anchor.textContent?.trim() || rawHref, href: rawHref };
    }
  } catch {
    return null;
  }
  return null;
}
