import { openUrl } from "@tauri-apps/plugin-opener";
import { reportError } from "@/stores/toastStore";
import type { LinkAnalysis } from "@/utils/phishingDetector";
import type { EmailDataAction } from "@/utils/emailDataActions";

export const CONFIRM_THRESHOLD = 20;

export interface EmailNavigationHandler {
  run(actionId: string): boolean;
  resolveFallback(url: string): EmailDataAction | null;
  showFallback(action: EmailDataAction): void;
  analyze(url: string): LinkAnalysis | null;
  confirm(analysis: LinkAnalysis): void;
}

const handlers = new Map<string, EmailNavigationHandler>();

export function registerEmailNavigationHandler(
  rendererId: string,
  handler: EmailNavigationHandler,
): () => void {
  handlers.set(rendererId, handler);
  return () => {
    if (handlers.get(rendererId) === handler) handlers.delete(rendererId);
  };
}

export async function openExternalLink(url: string): Promise<void> {
  for (const handler of handlers.values()) {
    const action = handler.resolveFallback(url);
    if (action && action.kind !== "url" && action.kind !== "app") {
      handler.showFallback(action);
      return;
    }
  }

  for (const handler of handlers.values()) {
    const analysis = handler.analyze(url);
    if (analysis && analysis.riskScore >= CONFIRM_THRESHOLD) {
      handler.confirm(analysis);
      return;
    }
  }

  try {
    await openUrl(url);
  } catch (err) {
    reportError("Could not open link", err);
  }
}

export function dispatchEmailNavigation(url: string): void {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const appOrigin = (parsed.protocol === "tauri:" && parsed.hostname === "localhost")
      || (parsed.origin !== "null" && parsed.origin === window.location.origin);
    if (appOrigin && parts[0] === "__sndmail_email_action__") {
      const [, rendererId, actionId] = parts;
      if (rendererId && actionId && handlers.get(rendererId)?.run(actionId)) return;
      reportError("Could not open email action", "The message action is no longer available.");
      return;
    }
  } catch {
    // Raw external URLs are handled below.
  }
  void openExternalLink(url);
}

export async function startEmailNavigationListener(): Promise<() => void> {
  const handleNavigation = (event: Event) => {
    const url = (event as CustomEvent<unknown>).detail;
    if (typeof url === "string" && url) {
      dispatchEmailNavigation(url);
    }
  };
  window.addEventListener("sndmail-email-navigation", handleNavigation);
  return () => window.removeEventListener("sndmail-email-navigation", handleNavigation);
}
