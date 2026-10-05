import { detectOtpCode, detectSignInLink } from "@/utils/otpDetector";
import { getSetting } from "@/services/db/settings";
import { notifyOneTimeCode } from "@/services/notifications/notificationManager";
import { reportError, notify } from "@/stores/toastStore";

/**
 * One-time codes and sign-in links, surfaced the moment they arrive.
 *
 * A login code is worth nothing thirty seconds later, so the point is to
 * spare the user from opening the mail at all: the code goes on the clipboard
 * and into a notification, and a magic link becomes one click.
 */

/**
 * How recent a message must be to act on. Without this, the first sync of an
 * account would copy a two-year-old code over whatever the user was holding,
 * and fire a notification for every login they have ever done.
 */
const MAX_AGE_MS = 10 * 60 * 1000;

/** Codes already acted on, so a re-sync of the same message stays quiet. */
const handled = new Set<string>();

export interface OtpCandidate {
  id: string;
  /** So the notification can open the message it came from. */
  threadId?: string;
  accountId?: string;
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  date: number;
  fromName?: string | null;
  fromAddress?: string | null;
}

export interface OtpOutcome {
  code: string | null;
  linkUrl: string | null;
  copied: boolean;
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    // The Rust side, deliberately: navigator.clipboard needs the document
    // focused, and the whole point is that the user is in another app
    const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
    await writeText(text);
    return true;
  } catch (err) {
    console.error("Failed to copy one-time code via the plugin:", err);
  }
  try {
    // Worth trying anyway: if the window happens to be focused this works,
    // and a copied code is the whole point
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    reportError("Could not copy the login code", err);
    return false;
  }
}

/**
 * Act on the codes and sign-in links in a batch of newly arrived messages.
 *
 * Returns what was found, so callers can test it without a clipboard or a
 * notification centre.
 */
export async function processIncomingCodes(
  messages: OtpCandidate[],
  now = Date.now(),
): Promise<OtpOutcome[]> {
  if (messages.length === 0) return [];

  const enabled = (await getSetting("otp_detection")) !== "false";
  if (!enabled) return [];
  const autoCopy = (await getSetting("otp_auto_copy")) !== "false";

  const outcomes: OtpOutcome[] = [];

  for (const message of messages) {
    if (handled.has(message.id)) continue;
    if (now - message.date > MAX_AGE_MS) continue;

    // A login mail often carries both — "tap the button, or enter this
    // code" — and the user decides which they want, so both are offered
    const match = detectOtpCode(message.subject, message.bodyText ?? stripTags(message.bodyHtml));
    const link = detectSignInLink(message.bodyHtml);
    if (!match && !link) continue;

    handled.add(message.id);
    const sender = message.fromName ?? message.fromAddress ?? "";
    const copied = match && autoCopy ? await writeClipboard(match.code) : false;

    try {
      notifyOneTimeCode({
        code: match?.code,
        linkUrl: link?.url,
        sender,
        copied,
        threadId: message.threadId,
        accountId: message.accountId,
      });
    } catch (err) {
      console.error("Failed to notify about a one-time code:", err);
    }

    // The desktop notification carries buttons only on a bundled macOS build
    // (see notificationManager); everywhere else the plugin hands the text to
    // the OS and that is all. So the buttons also live here, in the app, and
    // stay until used or dismissed — a notification is gone in seconds
    const actions = [];
    if (match) {
      actions.push({
        label: copied ? "Copy again" : "Copy code",
        keepOpen: true,
        run: async () => { await writeClipboard(match.code); },
      });
    }
    if (link) {
      actions.push({
        label: "Open sign-in link",
        run: () => {
          window.dispatchEvent(new CustomEvent("snd-open-signin-link", {
            detail: { url: link.url, threadId: message.threadId, accountId: message.accountId },
          }));
        },
      });
    }
    notify(
      "info",
      match ? (copied ? `Code copied: ${match.code}` : `Code: ${match.code}`) : "Sign-in link",
      `From ${sender}`,
      null,
      actions,
    );

    outcomes.push({ code: match?.code ?? null, linkUrl: link?.url ?? null, copied });
  }

  return outcomes;
}

/** Crude text from HTML, for messages that carry no plain-text part. */
function stripTags(html: string | null): string | null {
  if (!html) return null;
  if (typeof DOMParser === "undefined") return html.replace(/<[^>]+>/g, " ");
  try {
    return new DOMParser().parseFromString(html, "text/html").body?.textContent ?? null;
  } catch {
    return null;
  }
}

/** Test seam: forget what has already been acted on. */
export function resetHandledCodes(): void {
  handled.clear();
}
