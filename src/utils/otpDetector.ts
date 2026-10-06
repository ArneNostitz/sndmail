/**
 * Find the one-time code in a message.
 *
 * The bar is deliberately high. A false positive is not a harmless miss: with
 * auto-copy on it silently replaces whatever the user had on their clipboard,
 * so an order number or a year must never be mistaken for a login code. A
 * code is only reported when a word that means "this is a code" sits next to
 * a token that looks like one.
 */

export interface OtpMatch {
  code: string;
  /** The words that qualified it, for the banner to explain itself. */
  context: string;
}

/**
 * Words that introduce a code, across the languages this mailbox sees. Kept
 * narrow: "password" alone is not here, because "your password has changed"
 * is a notification, not a code.
 */
const KEYWORDS = [
  "one-time code", "one time code", "onetime code", "one-time password",
  "verification code", "verify code", "security code", "login code",
  "access code", "confirmation code", "authentication code", "auth code",
  "sign-in code", "sign in code", "passcode", "otp", "2fa",
  "two-factor", "two factor", "single-use code",
  // German
  "bestätigungscode", "bestaetigungscode", "sicherheitscode",
  "verifizierungscode", "anmeldecode", "einmalcode", "einmalpasswort",
  "zugangscode", "authentifizierungscode",
  // French / Spanish / Italian / Dutch
  "code de vérification", "code de verification", "code de sécurité",
  "código de verificación", "codigo de verificacion", "código de seguridad",
  "codice di verifica", "verificatiecode", "beveiligingscode",
];

/**
 * A plausible code: 4–8 digits, or 6–8 characters mixing letters and digits.
 * Purely alphabetic runs are excluded — they are words.
 */
const CODE_PATTERN = /\b(?:\d[\d  -]{2,10}\d|[A-Z0-9]{6,8})\b/g;

/**
 * A bare "code" is far weaker evidence than "verification code", but plenty
 * of senders write nothing else — "ODER DIESER CODE" above the digits. Taken
 * only when no word nearby turns it into a different kind of code.
 */
const WEAK_KEYWORDS = ["code", "kode", "codigo", "código", "codice", "pin"];

/** Words that make a nearby "code" something other than a login code. */
const NOT_A_LOGIN_CODE =
  /\b(promo|discount|coupon|voucher|gutschein|rabatt|order|bestell|tracking|sendungs|referral|invite|einladung|error|fehler|country|zip|post)\w*/i;

/** How far from a keyword a code may sit and still belong to it. */
const WINDOW = 60;

/** A weak keyword has to sit closer — it is carrying less evidence. */
const WEAK_WINDOW = 30;

/** Years and other numbers that are never one-time codes. */
function isImplausible(code: string): boolean {
  const digits = code.replace(/\D/g, "");
  if (digits.length < 4 || digits.length > 8) {
    // Alphanumeric codes keep their letters, so only reject on length
    if (!/^[A-Z0-9]{6,8}$/.test(code)) return true;
    if (!/\d/.test(code) || !/[A-Z]/.test(code)) return true;
    return false;
  }
  // A bare four-digit number in the range of a plausible year is too risky
  if (digits.length === 4) {
    const asNumber = parseInt(digits, 10);
    if (asNumber >= 1900 && asNumber <= 2200) return true;
  }
  // All-same digits is a placeholder in a template, not a real code
  if (/^(\d)\1+$/.test(digits)) return true;
  return false;
}

/** Normalise the spacing some senders put inside a code ("123 456"). */
function tidy(code: string): string {
  return /^[\d  -]+$/.test(code) ? code.replace(/[  -]/g, "") : code;
}

/**
 * Extract a one-time code from a message's subject and body.
 *
 * Returns null unless a code keyword and a code-shaped token appear within
 * `WINDOW` characters of each other. The subject is searched first: senders
 * increasingly put the code there precisely so it can be read without opening
 * the mail.
 */
export function detectOtpCode(
  subject: string | null,
  body: string | null,
): OtpMatch | null {
  for (const source of [subject, body]) {
    if (!source) continue;
    const match = findInText(source);
    if (match) return match;
  }
  return null;
}

function findInText(raw: string): OtpMatch | null {
  // Lines that are nothing but a code, possibly with a "Code:" label — the
  // shape a login mail uses so the digits can be read at a glance
  const standalone = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const bare = line
      .toLowerCase()
      .replace(new RegExp(`\\b(?:${WEAK_KEYWORDS.join("|")})\\b`, "g"), "")
      .replace(/[\s  :.\-–—]/g, "");
    if (/^\d{5,8}$/.test(bare)) standalone.add(bare);
  }

  // Collapse whitespace so a code split across a line break still reads as one
  const text = raw.replace(/\s+/g, " ");
  const haystack = text.toLowerCase();

  type Best = { code: string; distance: number; context: string };
  const found: Best[] = [];

  const scan = (keyword: string, window: number, weak: boolean) => {
    let from = 0;
    for (;;) {
      // Whole words only, weak or strong: "otp" inside a tracking-URL token
      // was qualifying the nearest number in a newsletter footer
      const at = indexOfWord(haystack, keyword, from);
      if (at === -1) break;
      from = at + keyword.length;

      const start = Math.max(0, at - window);
      const end = Math.min(text.length, at + keyword.length + window);
      const around = text.slice(start, end);

      // "promo code", "order code" and friends are not login codes
      if (weak && NOT_A_LOGIN_CODE.test(around)) continue;

      CODE_PATTERN.lastIndex = 0;
      let candidate: RegExpExecArray | null;
      while ((candidate = CODE_PATTERN.exec(around)) !== null) {
        const code = tidy(candidate[0]!.trim());
        if (isImplausible(code)) continue;
        // A weak keyword only qualifies a plainly code-shaped number that
        // stands on its own line — a login code is set apart to be read,
        // a postal code sits inside an address
        if (weak && !/^\d{5,8}$/.test(code)) continue;
        if (weak && !standalone.has(code)) continue;
        // In an address line the number is followed by the town
        if (looksLikePostalAddress(around, candidate.index, candidate[0]!.length)) continue;
        // Prefer the code closest to the words that qualified it
        const absolute = start + candidate.index;
        found.push({ code, distance: Math.abs(absolute - at), context: keyword });
      }
    }
  };

  for (const keyword of KEYWORDS) scan(keyword, WINDOW, false);
  // The weak "code" label is only consulted when nothing better spoke up
  if (found.length === 0) {
    for (const keyword of WEAK_KEYWORDS) scan(keyword, WEAK_WINDOW, true);
  }

  // The code nearest the words that qualified it
  const best = found.reduce<Best | null>(
    (winner, entry) => (!winner || entry.distance < winner.distance ? entry : winner),
    null,
  );
  return best ? { code: best.code, context: best.context } : null;
}

/** Find `word` only where it stands alone, not inside a longer word. */
function indexOfWord(haystack: string, word: string, from: number): number {
  let at = from;
  for (;;) {
    const found = haystack.indexOf(word, at);
    if (found === -1) return -1;
    const before = found === 0 ? " " : haystack[found - 1]!;
    const afterIdx = found + word.length;
    const after = afterIdx >= haystack.length ? " " : haystack[afterIdx]!;
    if (!/[a-z0-9]/i.test(before) && !/[a-z0-9]/i.test(after)) return found;
    at = found + word.length;
  }
}

/**
 * Words that mark a link as the one that signs you in, rather than the
 * unsubscribe footer or a marketing button sitting next to it.
 */
const ONE_TIME_AUTH_CONTEXT = /\b(?:magic\s+(?:(?:sign[ -]?in|log[ -]?in|login)\s+)?link|passwordless\s+(?:(?:sign[ -]?in|log[ -]?in|login)\s+)?link|(?:one[ -]?time|single[ -]?use)\s+(?:passwordless\s+)?(?:sign[ -]?in|log[ -]?in|login)\s+link|(?:sign[ -]?in|log[ -]?in|login)\s+(?:magic|passwordless)\s+link|einmalige[rnms]?\s+anmeldelink)\b/i;
const SIGN_IN_LABEL = /\b(?:sign\s+in|sign-in|signin|log\s+in|log-in|login|anmelden|einloggen)\b/i;
const NON_LOGIN_ACTION = /\b(?:reset|activate|activation|confirm|confirmation|subscribe|subscription|purchase|register|registration|event|bestätig|bestaetig|aktivier|zurücksetzen|zuruecksetzen)\w*/i;

/** Links that are never the sign-in link, however they are worded. */
const LINK_EXCLUDE = /unsubscribe|abmelden|preferences|privacy|terms|imprint|impressum|\.(png|jpg|jpeg|gif|svg|css)(\?|$)/i;

export interface SignInLink {
  url: string;
  /** The anchor's own words, so the notification can name it. */
  label: string;
}

/**
 * Find the sign-in link in a message body.
 *
 * Anchors are read from the HTML rather than the text so the link's own words
 * can qualify it — "Sign in to your account" is the button, the bare URL next
 * to the footer is not. Returns null when nothing clearly qualifies; guessing
 * here would put a one-click launcher on an arbitrary link in an email.
 */
export function detectSignInLink(
  html: string | null,
  subject: string | null = null,
  bodyText: string | null = null,
): SignInLink | null {
  if (!html || typeof DOMParser === "undefined") return null;

  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, "text/html");
  } catch {
    return null;
  }

  doc.querySelectorAll("script, style").forEach((node) => node.remove());
  const htmlTextOnly = doc.body.innerHTML.replace(/<[^>]*>/g, " ");
  const visibleHtmlText = new DOMParser().parseFromString(htmlTextOnly, "text/html").body.textContent ?? "";
  const visibleBodyText = `${bodyText ?? ""} ${visibleHtmlText}`;
  const messageContext = `${subject ?? ""} ${visibleBodyText}`;
  if (!ONE_TIME_AUTH_CONTEXT.test(messageContext)) return null;

  for (const anchor of Array.from(doc.querySelectorAll("a[href]"))) {
    const url = anchor.getAttribute("href")?.trim();
    if (!url || !/^https?:\/\//i.test(url)) continue;
    if (linkIsExcluded(url)) continue;

    const label = (anchor.textContent ?? "").replace(/\s+/g, " ").trim();
    if (LINK_EXCLUDE.test(label)) continue;
    const targetKind = messageSpecificAuthTarget(url);
    if (!targetKind || NON_LOGIN_ACTION.test(label) || NON_LOGIN_ACTION.test(new URL(url).pathname)) continue;
    if (!SIGN_IN_LABEL.test(label) && targetKind !== "provider-magic") continue;

    return { url, label: label || url };
  }
  return null;
}

/** Require a message-specific secret destination or explicit magic-link path. */
function messageSpecificAuthTarget(rawUrl: string): "provider-magic" | "direct" | null {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return null; }
  const path = url.pathname.toLowerCase();
  const segments = path.split("/").filter(Boolean);
  const secret = (key: string) => !!url.searchParams.get(key)?.trim();
  const supabaseMagic = segments.join("/") === "auth/v1/verify" && url.searchParams.get("type") === "magiclink" && secret("token_hash");
  const appwriteMagic = segments.slice(-3).join("/") === "account/sessions/magic-url" && secret("userId") && secret("secret");
  if (supabaseMagic || appwriteMagic) return "provider-magic";
  const magicPath = segments.some((segment) => /^(?:magic(?:-link)?|one-time|passwordless|sign-in-link)$/.test(segment));
  const trackedAuthPath = segments.some((segment) => /^(?:track|tracking|click|redirect|r|t)$/.test(segment));
  const opaqueTrackedValue = [...url.searchParams.values()].some((value) => value.trim().length > 0);
  const secretParameter = [...url.searchParams].some(([key, value]) =>
    /^(?:token|code|key|state|ticket|auth|nonce|login_token|magic_token)$/i.test(key) && value.trim().length > 0,
  );
  return (secretParameter && magicPath) || (trackedAuthPath && opaqueTrackedValue) ? "direct" : null;
}

function linkIsExcluded(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return LINK_EXCLUDE.test(url.pathname);
  } catch {
    return true;
  }
}

/**
 * "Leipziger Str. 56, 10117 Berlin": a five-digit number that is followed by
 * a capitalised word and preceded by a comma is a postal code in an address,
 * whatever else is nearby.
 */
function looksLikePostalAddress(around: string, index: number, length: number): boolean {
  const before = around.slice(Math.max(0, index - 3), index);
  const after = around.slice(index + length, index + length + 24);
  return /,\s*$/.test(before) && /^\s+[A-ZÄÖÜ][a-zäöüß]+/.test(after);
}
