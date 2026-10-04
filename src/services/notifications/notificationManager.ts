import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { getSetting } from "../db/settings";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useComposerStore } from "../../stores/composerStore";
import { navigateToLabel } from "../../router/navigate";
import { normalizeEmail } from "@/utils/emailUtils";
import { reportError } from "@/stores/toastStore";
import {
  nativeNotificationsAvailable,
  requestNativePermission,
  registerNativeCategories,
  showNativeNotification,
  listenForNativeActions,
  type NativeCategory,
  type NativeNotificationResponse,
} from "./nativeNotifications";

/**
 * Desktop notifications, with buttons where the platform can draw them.
 *
 * Two backends. On a bundled macOS build the Rust side talks to
 * UNUserNotificationCenter: a category names the buttons, every notification
 * carries its own context, and a press comes back as `sndmail-notification-action`
 * with that context — so Reply opens the thread it was pressed on and Copy
 * code copies that code, however many notifications are stacked. Everywhere
 * else (Windows, Linux, and a bare `tauri dev` binary, which has no bundle for
 * the centre to accept) the notification plugin shows plain text: it hands the
 * text to the OS and hears nothing back, so there are no buttons and even a
 * click goes unseen. The in-app toast and `OneTimeCodeBanner` carry the
 * buttons there.
 */

export type NotificationBackend = "native" | "plugin" | "off";

let backend: NotificationBackend = "off";
let nativeFailure: string | null = null;
let initialized = false;
let stopListening: (() => void) | null = null;

export interface NotificationContext {
  threadId?: string;
  accountId?: string;
  fromAddress?: string;
  subject?: string;
  /** A one-time code the notification is offering to copy. */
  code?: string;
  /** A sign-in link the notification is offering to open. */
  linkUrl?: string;
}

/** The button sets. Ids come back verbatim in the press. */
export const NOTIFICATION_CATEGORIES: NativeCategory[] = [
  {
    id: "email",
    actions: [
      { id: "reply", title: "Reply", foreground: true },
      { id: "archive", title: "Archive" },
    ],
  },
  {
    id: "otp-code",
    actions: [{ id: "copy-code", title: "Copy code" }],
  },
  {
    id: "otp-link",
    actions: [{ id: "open-link", title: "Follow link", foreground: true }],
  },
  {
    id: "otp-both",
    actions: [
      { id: "copy-code", title: "Copy code" },
      { id: "open-link", title: "Follow link", foreground: true },
    ],
  },
];

async function showAndFocusMainWindow(): Promise<void> {
  const mainWindow = await WebviewWindow.getByLabel("main");
  if (mainWindow) {
    await mainWindow.show();
    await mainWindow.setFocus();
  }
}

/**
 * Pick a backend and, on the native one, ask for permission and start
 * listening for presses.
 */
export async function initNotifications(options: { quietNativeFailure?: boolean } = {}): Promise<void> {
  if (initialized) return;
  initialized = true;

  const setting = await getSetting("notifications_enabled");
  if (setting === "false") {
    backend = "off";
    return;
  }

  if (await nativeNotificationsAvailable()) {
    try {
      // The first call shows the system prompt; a refusal there is the OS
      // saying no, and the plugin path would be refused just the same
      const granted = await requestNativePermission();
      if (!granted) {
        backend = "off";
        nativeFailure = null;
        return;
      }
      await registerNativeCategories(NOTIFICATION_CATEGORIES);
      stopListening = await listenForNativeActions(handleNativeAction);
      backend = "native";
      nativeFailure = null;
      return;
    } catch (err) {
      // The centre is there and it refused us. Worth saying out loud and
      // worth keeping: it is the difference between "this platform draws no
      // buttons" and "this build was rejected", and the settings page has no
      // other way to tell the two apart.
      nativeFailure = err instanceof Error ? err.message : String(err);
      // The separate background worker has its own macOS notification grant.
      // A refusal for the main app must not claim its mail alerts are broken.
      if (!options.quietNativeFailure) reportError("Notification buttons are unavailable", err);
      // Plain notifications still beat none
    }
  } else {
    nativeFailure = null;
  }

  let granted = await isPermissionGranted();
  if (!granted) {
    const permission = await requestPermission();
    granted = permission === "granted";
  }
  backend = granted ? "plugin" : "off";
}

/** Which path notifications take — for the settings page and tests. */
export function getNotificationBackend(): NotificationBackend {
  return backend;
}

/**
 * Why the buttons are missing when the notification centre was there but
 * turned sndmail down — `null` when nothing was refused. An ad-hoc "linker
 * signed" bundle is the usual cause: the centre identifies an app by its
 * code-signing identifier, and an unsigned bundle has none it recognises.
 */
export function getNativeNotificationFailure(): string | null {
  return nativeFailure;
}

/**
 * The settings toggle. Before this, switching notifications off only took
 * effect after a restart, because the module read the setting once at start.
 */
export async function applyNotificationsEnabled(enabled: boolean): Promise<void> {
  if (!enabled) {
    backend = "off";
    return;
  }
  if (backend !== "off") return;
  initialized = false;
  stopListening?.();
  stopListening = null;
  await initNotifications();
}

/**
 * A press on a native notification. The context is the one that
 * notification was sent with, never "the most recent".
 */
export async function handleNativeAction(response: NativeNotificationResponse): Promise<void> {
  const ctx = (response.context ?? {}) as NotificationContext;

  switch (response.actionId) {
    case "dismiss":
      return;

    case "copy-code":
      if (ctx.code) {
        await copyCode(ctx.code);
        return;
      }
      break;

    case "open-link":
      if (ctx.linkUrl) {
        // Through the app rather than straight to the browser: a link in
        // mail is exactly the phishing vector, so it passes the same check a
        // click inside the message would
        await showAndFocusMainWindow();
        window.dispatchEvent(new CustomEvent("sndmail-open-signin-link", {
          detail: { url: ctx.linkUrl, threadId: ctx.threadId, accountId: ctx.accountId },
        }));
        return;
      }
      break;

    case "reply":
      if (ctx.threadId && ctx.accountId) {
        await showAndFocusMainWindow();
        useComposerStore.getState().openComposer({
          mode: "reply",
          to: ctx.fromAddress ? [ctx.fromAddress] : [],
          subject: ctx.subject ? `Re: ${ctx.subject}` : "",
          threadId: ctx.threadId,
          accountId: ctx.accountId,
        });
        return;
      }
      break;

    case "archive":
      if (ctx.threadId && ctx.accountId) {
        try {
          const { archiveThread } = await import("../emailActions");
          await archiveThread(ctx.accountId, ctx.threadId, []);
        } catch (err) {
          reportError("Could not archive from the notification", err);
        }
        return;
      }
      break;
  }

  // A click on the body, or a button whose context is missing: open the mail
  await showAndFocusMainWindow();
  if (!ctx.threadId) return;
  // The thread need not be in the list on screen — a rule may have archived
  // it, it may belong to another mailbox, or the app may have only just
  // started and loaded nothing yet. Cache it first so the reading pane has
  // something to render instead of "Select an email to read".
  if (ctx.accountId) {
    try {
      const { cacheThreadForOpening } = await import("../threads/openThread");
      await cacheThreadForOpening(ctx.accountId, ctx.threadId);
    } catch (err) {
      reportError("Could not open the email from the notification", err);
    }
  }
  navigateToLabel("inbox", { threadId: ctx.threadId });
}

async function copyCode(code: string): Promise<void> {
  try {
    // The Rust side: navigator.clipboard needs the document focused, and a
    // notification button is pressed from another app
    const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
    await writeText(code);
  } catch (err) {
    reportError("Could not copy the login code", err);
    return;
  }
  // The pressed notification is gone; this is the only feedback the user gets
  void show({ title: `Copied ${code}`, body: "Ready to paste" });
}

interface ShowOptions {
  title: string;
  body: string;
  /** One of `NOTIFICATION_CATEGORIES`; omit for a plain notification. */
  category?: string;
  context?: NotificationContext;
}

async function show(opts: ShowOptions): Promise<void> {
  if (backend === "off") return;

  if (backend === "native") {
    try {
      await showNativeNotification({
        title: opts.title,
        body: opts.body,
        categoryId: opts.category,
        context: opts.context,
        group: opts.context?.threadId,
      });
      return;
    } catch (err) {
      console.error("Native notification failed, showing a plain one:", err);
    }
  }

  sendNotification({ title: opts.title, body: opts.body });
}

/** Do notifications carry buttons on this backend? Wording depends on it. */
function hasButtons(): boolean {
  return backend === "native";
}

/**
 * Show a notification for new emails.
 * Batches notifications to avoid spam during sync.
 */
interface PendingEmail {
  from: string;
  context: NotificationContext;
}

/** Up to this many arrivals in one batch are announced one by one, with buttons. */
const INDIVIDUAL_LIMIT = 3;

let pendingEmails: PendingEmail[] = [];
let notifyTimer: ReturnType<typeof setTimeout> | null = null;

export function queueNewEmailNotification(
  from: string,
  subject: string,
  threadId?: string,
  accountId?: string,
  fromAddress?: string,
): void {
  if (backend === "off") return;

  pendingEmails.push({ from, context: { threadId, accountId, fromAddress, subject } });

  // Debounce: wait 2s before showing, to batch during sync
  if (notifyTimer) clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => {
    const batch = pendingEmails;
    pendingEmails = [];
    notifyTimer = null;

    if (batch.length <= INDIVIDUAL_LIMIT) {
      for (const mail of batch) {
        void show({
          title: mail.from,
          body: mail.context.subject || "(No subject)",
          category: "email",
          context: mail.context,
        });
      }
    } else {
      void show({ title: "sndmail", body: `${batch.length} new emails` });
    }
  }, 2000);
}

/**
 * Determine if a new email should trigger a notification based on smart notification settings.
 * Pure function — no I/O, all config is passed in from the sync cycle.
 */
export function shouldNotifyForMessage(
  smartEnabled: boolean,
  allowedCategories: Set<string>,
  vipSenders: Set<string>,
  threadCategory: string | null,
  fromAddress?: string,
  opts?: {
    /** Mailboxes chosen in settings. Empty means every account notifies. */
    allowedAccounts?: Set<string>;
    accountId?: string;
    /** A mail rule matched this message with a "Notify me" action. */
    ruleRequested?: boolean;
  },
): boolean {
  // A mailbox the user did not pick stays quiet even for a rule or a VIP — it
  // is the coarsest choice they made, so it wins. Picking none means none:
  // silence is a setting, not an empty list to be ignored. One-time codes and
  // sign-in links never reach this function, so they still come through.
  const allowedAccounts = opts?.allowedAccounts;
  if (allowedAccounts && opts?.accountId && !allowedAccounts.has(opts.accountId)) {
    return false;
  }
  // A rule saying "notify me" is an explicit instruction, so it outranks the
  // category filter the same way a VIP does
  if (opts?.ruleRequested) return true;
  if (!smartEnabled) return true; // Smart notifications off → notify everything
  if (fromAddress && vipSenders.has(normalizeEmail(fromAddress))) return true; // VIP always notifies
  const category = threadCategory ?? "Primary"; // uncategorized defaults to Primary
  return allowedCategories.has(category);
}

/**
 * Show a notification for a follow-up reminder that fired. A click opens
 * the thread; there is no sensible button for "you are still waiting".
 */
export function notifyFollowUpDue(
  subject: string,
  threadId?: string,
  accountId?: string,
): void {
  void show({
    title: "Follow up needed",
    body: subject || "(No subject)",
    context: { threadId, accountId, subject },
  });
}

/**
 * Show a notification for a snoozed email returning.
 */
export function notifySnoozeReturn(subject: string): void {
  void show({ title: "Snoozed email returned", body: subject || "(No subject)" });
}

/**
 * Announce a one-time code or a sign-in link, with the buttons that make it
 * useful and the context the press needs.
 *
 * Without buttons (the plugin backend) the body says where the link is
 * waiting instead, because the notification itself can do nothing.
 */
export function notifyOneTimeCode(opts: {
  code?: string;
  linkUrl?: string;
  sender: string;
  copied: boolean;
  threadId?: string;
  accountId?: string;
}): void {
  const context: NotificationContext = {
    threadId: opts.threadId,
    accountId: opts.accountId,
    code: opts.code,
    linkUrl: opts.linkUrl,
  };
  const buttons = hasButtons();

  if (opts.code && opts.linkUrl) {
    void show({
      title: opts.copied ? `Code copied: ${opts.code}` : `Code: ${opts.code}`,
      body: buttons
        ? `From ${opts.sender}`
        : `From ${opts.sender} — ${opts.copied ? "ready to paste. " : ""}Sign-in link waiting in sndmail`,
      category: "otp-both",
      context,
    });
    return;
  }

  if (opts.code) {
    void show({
      title: opts.copied ? `Code copied: ${opts.code}` : `Code: ${opts.code}`,
      body: opts.copied ? `From ${opts.sender} — ready to paste` : `From ${opts.sender}`,
      category: "otp-code",
      context,
    });
    return;
  }

  void show({
    title: "Sign-in link",
    body: buttons ? `From ${opts.sender}` : `From ${opts.sender} — open it from sndmail`,
    category: "otp-link",
    context,
  });
}

/**
 * From Settings: a notification shaped like a real one, so the user can see
 * whether buttons appear and press one. The code is a real code as far as
 * the press is concerned — Copy code puts it on the clipboard.
 */
export async function sendTestNotification(): Promise<NotificationBackend> {
  if (backend === "off") return backend;
  await show({
    title: hasButtons() ? "Code: 123456" : "sndmail notifications are working",
    body: hasButtons()
      ? "A test from sndmail — press Copy code"
      : "This platform draws no buttons; the in-app toast carries them",
    category: "otp-code",
    context: { code: "123456" },
  });
  return backend;
}

/** Test seam: forget the chosen backend so the next init picks again. */
export function resetNotificationsForTests(): void {
  initialized = false;
  backend = "off";
  nativeFailure = null;
  stopListening = null;
  pendingEmails = [];
  if (notifyTimer) clearTimeout(notifyTimer);
  notifyTimer = null;
}
