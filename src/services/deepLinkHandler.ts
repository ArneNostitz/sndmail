import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { parseMailtoUrl } from "../utils/mailtoParser";
import { useComposerStore } from "../stores/composerStore";
import { escapeHtml } from "../utils/sanitize";
import { parseMailLink } from "../utils/mailLink";
import { openMailLink } from "./threads/openMailLink";
import { reportError } from "../stores/toastStore";

export async function handleUrl(url: string): Promise<void> {
  if (!/^(mailto|sndmail):/i.test(url)) return;

  // Show and focus the main window
  const mainWindow = await WebviewWindow.getByLabel("main");
  if (mainWindow) {
    await mainWindow.show();
    await mainWindow.setFocus();
  }

  if (/^sndmail:/i.test(url)) {
    await openMailLink(parseMailLink(url));
    return;
  }

  const fields = parseMailtoUrl(url);

  // Open composer with parsed fields
  useComposerStore.getState().openComposer({
    mode: "new",
    to: fields.to,
    cc: fields.cc,
    bcc: fields.bcc,
    subject: fields.subject,
    bodyHtml: fields.body ? `<p>${escapeHtml(fields.body)}</p>` : "",
  });
}

export async function initDeepLinkHandler(): Promise<() => void> {
  const cleanups: Array<() => void> = [];
  let disposed = false;
  let queue = Promise.resolve();
  const recent = new Map<string, number>();
  // OS events, getCurrent, and single-instance forwarding can deliver the same
  // link together. Serialize distinct opens; coalesce duplicate deliveries.
  const receive = (urls: string[]) => {
    for (const url of urls) {
      if (!/^(mailto|sndmail):/i.test(url)) continue;
      const now = Date.now();
      for (const [key, time] of recent) if (now - time > 1500) recent.delete(key);
      if (recent.has(url)) continue;
      recent.set(url, now);
      queue = queue.then(async () => {
        if (!disposed) await handleUrl(url);
      }).catch((error) => { reportError("Could not open mail link", error); });
    }
  };

  // Listen for URLs when app is already running
  try {
    const unlistenOpenUrl = await onOpenUrl(receive);
    cleanups.push(unlistenOpenUrl);
  } catch (err) {
    console.error("Failed to register deep link handler:", err);
  }

  // Listen for forwarded args from single-instance plugin
  try {
    const unlistenArgs = await listen<string[]>("single-instance-args", (event) => {
      receive(event.payload);
    });
    cleanups.push(unlistenArgs);
  } catch (err) {
    console.error("Failed to listen for single-instance args:", err);
  }

  // App initializes this after migrations/accounts are ready. The native
  // plugin retains the URL that launched it while the frontend was loading.
  try {
    receive(await getCurrent() ?? []);
    await queue;
  } catch (error) {
    reportError("Could not read startup mail link", error);
  }

  return () => {
    disposed = true;
    for (const cleanup of cleanups) {
      cleanup();
    }
  };
}
