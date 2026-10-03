import { useRef, useCallback, useLayoutEffect, useMemo, useState, useEffect } from "react";
import { ImageOff } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { stripRemoteImages, hasBlockedImages } from "@/utils/imageBlocker";
import { addToAllowlist } from "@/services/db/imageAllowlist";
import { sanitizeHtml } from "@/utils/sanitize";
import { linkifyPlainText } from "@/utils/linkify";
import { useUIStore } from "@/stores/uiStore";
import { useAccountStore } from "@/stores/accountStore";
import { useComposerStore } from "@/stores/composerStore";
import { reportError, notify } from "@/stores/toastStore";
import { LinkConfirmDialog } from "./LinkConfirmDialog";
import { EmailDataActionMenu } from "./EmailDataActionMenu";
import { EventCreateModal } from "@/components/calendar/EventCreateModal";
import type { LinkAnalysis, MessageScanResult } from "@/utils/phishingDetector";
import type { DbAttachment } from "@/services/db/attachments";
import type { DbCalendar } from "@/services/db/calendars";
import { getCalendarsForAccount } from "@/services/db/calendars";
import { getContactByEmail, upsertContact } from "@/services/db/contacts";
import { createCalendarEvent, type CalendarEventDraft } from "@/services/calendar/createEvent";
import { hasCalendarSupport } from "@/services/calendar/providerFactory";
import { parseMailtoUrl } from "@/utils/mailtoParser";
import { escapeHtml } from "@/utils/sanitize";
import {
  decorateEmailData,
  instrumentEmailActions,
  type EmailDataAction,
  type InstrumentedEmailAction,
} from "@/utils/emailDataActions";
import {
  CONFIRM_THRESHOLD,
  registerEmailNavigationHandler,
} from "@/services/links/emailNavigation";
import { highlightSearchTerms } from "@/utils/searchHighlight";
import { EMAIL_FRAME_CSP, EMAIL_FRAME_SANDBOX } from "@/utils/emailFramePolicy";

export interface EmailSelectionRequest {
  position: { x: number; y: number };
  text: string;
  contextMenu?: boolean;
}

/**
 * Match a clicked anchor against the pre-computed scan results.
 *
 * scanLinksInHtml records the raw `href` attribute, while `anchor.href` is the
 * browser-resolved (and normalised) form, so try the raw attribute first and
 * fall back to comparing normalised URLs.
 */
function findAnalysis(
  scanResult: MessageScanResult | null,
  rawHref: string,
  resolvedHref: string,
): LinkAnalysis | null {
  if (!scanResult) return null;

  const direct = scanResult.links.find((l) => l.url === rawHref);
  if (direct) return direct;

  const normalise = (u: string): string | null => {
    try {
      return new URL(u).href;
    } catch {
      return null;
    }
  };
  const target = normalise(resolvedHref) ?? normalise(rawHref);
  if (!target) return null;

  return scanResult.links.find((l) => normalise(l.url) === target) ?? null;
}

interface EmailRendererProps {
  html: string | null;
  text: string | null;
  blockImages?: boolean;
  senderAddress?: string | null;
  accountId?: string | null;
  senderAllowlisted?: boolean;
  messageId?: string | null;
  inlineAttachments?: DbAttachment[];
  /** Result of the phishing link scan for this message, if scanning is enabled. */
  scanResult?: MessageScanResult | null;
  /** Free-text terms from the active search, only for a message that matched. */
  highlightTerms?: readonly string[];
  /** Lets the surrounding message offer sndmail actions for selected email text. */
  onSelectionContextMenu?: (request: EmailSelectionRequest) => void;
}

export function EmailRenderer({
  html,
  text,
  blockImages = false,
  senderAddress,
  accountId,
  senderAllowlisted = false,
  messageId,
  inlineAttachments,
  scanResult,
  highlightTerms,
  onSelectionContextMenu,
}: EmailRendererProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const rafRef = useRef<number>(0);
  const [rendererId] = useState(() => crypto.randomUUID());
  const navigationActionsRef = useRef<Map<string, InstrumentedEmailAction>>(new Map());
  const [overrideShow, setOverrideShow] = useState(false);
  const [cidMap, setCidMap] = useState<Map<string, string>>(new Map());
  const [pendingLink, setPendingLink] = useState<LinkAnalysis | null>(null);
  const [dataMenu, setDataMenu] = useState<{
    action: EmailDataAction;
    position: { x: number; y: number };
  } | null>(null);
  const [calendarDraft, setCalendarDraft] = useState<{
    action: EmailDataAction;
    accountId: string;
    calendars: DbCalendar[];
  } | null>(null);
  const selectionContextMenuRef = useRef(onSelectionContextMenu);

  useEffect(() => {
    selectionContextMenuRef.current = onSelectionContextMenu;
  }, [onSelectionContextMenu]);

  // Held in a ref so a scan arriving after render does not force the iframe
  // document to be rewritten (which would reset scroll position and images).
  const scanResultRef = useRef<MessageScanResult | null>(scanResult ?? null);
  useEffect(() => {
    scanResultRef.current = scanResult ?? null;
  }, [scanResult]);

  const theme = useUIStore((s) => s.theme);
  const selectedCalendarAccountId = useAccountStore((s) => s.calendarAccountId);
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const accounts = useAccountStore((s) => s.accounts);
  const highlightKey = highlightTerms?.join("\u0000") ?? "";
  const isDark = theme === "dark"
    || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);

  const shouldBlock = blockImages && !senderAllowlisted && !overrideShow;

  // Resolve cid: references by fetching inline attachment data
  useEffect(() => {
    if (!accountId || !messageId || !inlineAttachments?.length) return;

    const cidAttachments = inlineAttachments.filter(
      (a) => a.content_id && a.gmail_attachment_id,
    );
    if (cidAttachments.length === 0) return;

    let cancelled = false;

    (async () => {
      try {
        const { getEmailProvider } = await import("@/services/email/providerFactory");
        const provider = await getEmailProvider(accountId);
        const resolved = new Map<string, string>();

        await Promise.all(
          cidAttachments.map(async (att) => {
            try {
              const response = await provider.fetchAttachment(
                messageId,
                att.gmail_attachment_id!,
              );
              const base64 = response.data.replace(/-/g, "+").replace(/_/g, "/");
              resolved.set(att.content_id!, `data:${att.mime_type ?? "image/png"};base64,${base64}`);
            } catch {
              // Skip individual failures
            }
          }),
        );

        if (!cancelled && resolved.size > 0) {
          setCidMap(resolved);
        }
      } catch {
        // Non-critical — images just won't render
      }
    })();

    return () => { cancelled = true; };
  }, [accountId, messageId, inlineAttachments]);

  // Sanitize once — reused by both content and blocked-image check
  const sanitizedBody = useMemo(() => {
    if (!html) return null;
    return sanitizeHtml(html);
  }, [html]);

  const isPlainText = !sanitizedBody;

  const bodyHtml = useMemo(() => {
    // A plain-text body still has links in it — they just have no markup
    let body = sanitizedBody
      ?? `<pre style="white-space: pre-wrap; font-family: inherit;">${linkifyPlainText(text ?? "")}</pre>`;

    if (shouldBlock && sanitizedBody) {
      body = stripRemoteImages(body);
    }

    // Replace cid: references with resolved data URIs
    if (cidMap.size > 0) {
      body = body.replace(
        /\bcid:([^"'\s)]+)/gi,
        (match, cidRef: string) => cidMap.get(cidRef) ?? match,
      );
    }

    return body;
  }, [sanitizedBody, text, shouldBlock, cidMap]);

  const blocked = useMemo(() => {
    if (!shouldBlock || !sanitizedBody) return false;
    return hasBlockedImages(stripRemoteImages(sanitizedBody));
  }, [shouldBlock, sanitizedBody]);

  const openExternal = useCallback((url: string) => {
    openUrl(url).catch((err) => {
      reportError("Could not open link", err);
    });
  }, []);

  const showDataActions = useCallback((action: EmailDataAction) => {
    const entry = [...navigationActionsRef.current.values()].find((item) => item.action === action);
    const frame = iframeRef.current?.getBoundingClientRect();
    const anchor = entry?.anchor.getBoundingClientRect();
    setDataMenu({
      action,
      position: frame && anchor
        ? { x: frame.left + anchor.left, y: frame.top + anchor.bottom }
        : { x: frame?.left ?? 8, y: frame?.top ?? 8 },
    });
  }, []);

  const runNavigationAction = useCallback((actionId: string): boolean => {
    const entry = navigationActionsRef.current.get(actionId);
    if (!entry) return false;
    const { action, rawHref, resolvedHref } = entry;

    if (action.kind === "url") {
      const analysis = findAnalysis(scanResultRef.current, rawHref, resolvedHref);
      if (analysis && analysis.riskScore >= CONFIRM_THRESHOLD) {
        setPendingLink(analysis);
      } else {
        openExternal(resolvedHref);
      }
      return true;
    }
    if (action.kind === "app") {
      openExternal(action.href ?? resolvedHref);
      return true;
    }
    showDataActions(action);
    return true;
  }, [openExternal, showDataActions]);

  useEffect(() => registerEmailNavigationHandler(rendererId, {
    run: runNavigationAction,
    resolveFallback: (url) => {
      for (const entry of navigationActionsRef.current.values()) {
        if (entry.rawHref === url || entry.resolvedHref === url) return entry.action;
      }
      return null;
    },
    showFallback: showDataActions,
    analyze: (url) => findAnalysis(scanResultRef.current, url, url),
    confirm: setPendingLink,
  }), [rendererId, runNavigationAction, showDataActions]);

  // Write content directly into iframe document — synchronous, no srcDoc async parsing
  useLayoutEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    observerRef.current?.disconnect();

    const doc = iframe.contentDocument;
    if (!doc) return;

    let bindRaf = 0;
    let boundDocument: Document | null = null;

    const applyHeight = (activeDocument: Document) => {
      if (!activeDocument.body) return;
      const h = activeDocument.body.scrollHeight;
      if (h > 0) iframe.style.height = h + "px";
    };

    const showSelectionActions = (event?: Event): boolean => {
      // WebKit can replace the iframe document during doc.open()/close(). Read
      // from the iframe at interaction time, never from a previously captured
      // document or a browser-specific event target.
      const selection = iframe.contentDocument?.getSelection();
      const selectedText = selection?.toString().replace(/\s+/g, " ").trim();
      if (!selectedText || !selectionContextMenuRef.current) return false;

      const frame = iframe.getBoundingClientRect();
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      const selectionRect = typeof range?.getBoundingClientRect === "function"
        ? range.getBoundingClientRect()
        : null;
      const pointer = event && typeof (event as MouseEvent).clientX === "number"
        ? event as MouseEvent
        : null;
      selectionContextMenuRef.current?.({
        position: {
          // Selection-change events cover WebKit and keyboard selection. A
          // pointer refines the fallback where a hidden range has no geometry.
          x: frame.left + (selectionRect?.right || pointer?.clientX || 12),
          y: frame.top + (selectionRect?.bottom || pointer?.clientY || 12),
        },
        text: selectedText,
        ...(event?.type === "contextmenu" ? { contextMenu: true } : {}),
      });
      return true;
    };

    const handleSelectionContextMenu = (event: MouseEvent) => {
      if (showSelectionActions(event)) {
        event.preventDefault();
      } else {
        // DOM events do not bubble out of an iframe. Forward body clicks to the
        // same React message menu used by its header, in parent coordinates.
        const rect = iframe.getBoundingClientRect();
        const forwarded = new MouseEvent("contextmenu", {
          bubbles: true, cancelable: true,
          clientX: rect.left + event.clientX, clientY: rect.top + event.clientY,
        });
        if (!iframe.dispatchEvent(forwarded)) event.preventDefault();
      }
    };

    const handlePointerDown = () => {
      // Dismiss another message/list menu when entering the email document.
      iframe.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    };
    const unbindDocument = () => {
      boundDocument?.removeEventListener("contextmenu", handleSelectionContextMenu);
      boundDocument?.removeEventListener("mouseup", showSelectionActions);
      boundDocument?.removeEventListener("selectionchange", showSelectionActions);
      boundDocument?.removeEventListener("mousedown", handlePointerDown);
      boundDocument?.removeEventListener("keydown", handleKeyDown);
    };

    const bindDocument = () => {
      const activeDocument = iframe.contentDocument;
      if (!activeDocument?.body) return;
      unbindDocument();
      boundDocument = activeDocument;
      activeDocument.addEventListener("contextmenu", handleSelectionContextMenu);
      activeDocument.addEventListener("mouseup", showSelectionActions);
      activeDocument.addEventListener("selectionchange", showSelectionActions);
      activeDocument.addEventListener("mousedown", handlePointerDown);
      activeDocument.addEventListener("keydown", handleKeyDown);
      highlightSearchTerms(activeDocument.body, highlightTerms ?? []);
      decorateEmailData(activeDocument);
      const actions = instrumentEmailActions(activeDocument, rendererId);
      if (actions.size > 0) {
        navigationActionsRef.current = actions;
      } else if (!activeDocument.querySelector("[data-sndmail-action-id]")) {
        navigationActionsRef.current.clear();
      }
      observerRef.current?.disconnect();
      const resizeObserver = new ResizeObserver(() => {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = requestAnimationFrame(() => applyHeight(activeDocument));
      });
      resizeObserver.observe(activeDocument.body);
      observerRef.current = resizeObserver;
      applyHeight(activeDocument);
    };

    // WebKit may complete document replacement after doc.close(). Instrument
    // both immediately and on load; the action itself is handled natively.
    iframe.addEventListener("load", bindDocument);

    doc.open();
    // Plain text: blend with app theme (dark text on light bg, light text on dark bg)
    // HTML emails: always render on a light background since senders design for white/light
    const plainTextDark = isDark && isPlainText;
    const htmlDark = isDark && !isPlainText;
    doc.write(`<!DOCTYPE html>
<html>
<head>
  <meta http-equiv="Content-Security-Policy" content="${EMAIL_FRAME_CSP}">
  <style>
    body {
      margin: 0;
      padding: 16px;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      font-size: 14px;
      line-height: 1.6;
      color: ${plainTextDark ? "#e5e7eb" : "#1f2937"};
      background: ${htmlDark ? "#f8f9fa" : "transparent"};
      word-wrap: break-word;
      overflow-wrap: break-word;
      overflow: hidden;
    }
    img { max-width: 100%; height: auto; }
    a { color: ${plainTextDark ? "#60a5fa" : "#3b82f6"}; }
    blockquote {
      border-left: 3px solid ${plainTextDark ? "#4b5563" : "#d1d5db"};
      margin: 8px 0;
      padding: 4px 12px;
      color: ${plainTextDark ? "#9ca3af" : "#6b7280"};
    }
    pre { overflow-x: auto; }
    table { max-width: 100%; }
    a { cursor: pointer; }
    a[data-sndmail-kind="date"], a[data-sndmail-kind="phone"], a[data-sndmail-kind="address"] {
      text-decoration-style: dotted;
      text-underline-offset: 2px;
    }
    /* Email action links live in a sandboxed document, so render their hover
       hint locally with the same instant, high-contrast treatment as Tooltip. */
    a[data-sndmail-tooltip] { position: relative; }
    a[data-sndmail-tooltip]:hover::after,
    a[data-sndmail-tooltip]:focus-visible::after {
      content: attr(data-sndmail-tooltip);
      position: absolute;
      z-index: 2147483647;
      top: calc(100% + 8px);
      left: 50%;
      transform: translateX(-50%);
      max-width: min(20rem, calc(100vw - 16px));
      padding: 6px 10px;
      border: 1px solid #d1d5db;
      border-radius: 8px;
      background: #fff;
      color: #111827;
      box-shadow: 0 8px 20px rgb(0 0 0 / 18%);
      font: 12px/1.4 system-ui, sans-serif;
      white-space: normal;
      pointer-events: none;
    }
    mark[data-sndmail-search-match="true"] {
      background: #fde68a;
      color: inherit;
      border-radius: 2px;
      padding: 0 1px;
    }
  </style>
</head>
<body>${bodyHtml}</body>
</html>`);
    doc.close();
    bindDocument();
    bindRaf = requestAnimationFrame(bindDocument);

    return () => {
      iframe.removeEventListener("load", bindDocument);
      unbindDocument();
      observerRef.current?.disconnect();
      cancelAnimationFrame(rafRef.current);
      cancelAnimationFrame(bindRaf);
    };
  }, [bodyHtml, isDark, isPlainText, rendererId, highlightKey]);

  const handleLoadImages = useCallback(() => {
    setOverrideShow(true);
  }, []);

  const handleConfirmLink = useCallback(() => {
    const url = pendingLink?.url;
    setPendingLink(null);
    if (!url) return;
    openExternal(url);
  }, [pendingLink, openExternal]);

  const handleCopy = useCallback(async (value: string) => {
    try {
      const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
      await writeText(value);
      notify("success", "Copied", value);
    } catch (err) {
      reportError("Could not copy", err);
    }
  }, []);

  const handleCompose = useCallback((href: string) => {
    const fields = parseMailtoUrl(href);
    useComposerStore.getState().openComposer({
      mode: "new",
      to: fields.to,
      cc: fields.cc,
      bcc: fields.bcc,
      subject: fields.subject,
      bodyHtml: fields.body ? escapeHtml(fields.body).replace(/\r?\n/g, "<br>") : "",
      accountId: accountId ?? null,
    });
  }, [accountId]);

  const handleAddContact = useCallback(async (email: string, name: string | null) => {
    try {
      const existing = await getContactByEmail(email);
      if (existing) {
        notify("info", "Already in contacts", existing.display_name ?? existing.email);
        return;
      }
      await upsertContact(email, name);
      notify("success", "Contact created", name ? `${name} · ${email}` : email);
    } catch (err) {
      reportError("Could not create contact", err);
    }
  }, []);

  const handleBeginCreateEvent = useCallback(async (action: EmailDataAction) => {
    const candidates = [selectedCalendarAccountId, accountId, activeAccountId, ...accounts.map((item) => item.id)]
      .filter((id, index, all): id is string => Boolean(id) && all.indexOf(id) === index);
    try {
      let targetAccountId: string | null = null;
      for (const candidate of candidates) {
        if (await hasCalendarSupport(candidate)) {
          targetAccountId = candidate;
          break;
        }
      }
      if (!targetAccountId) {
        notify("warning", "Calendar is not configured", "Add a Google or CalDAV calendar account first.", null);
        return;
      }
      const calendars = await getCalendarsForAccount(targetAccountId);
      setCalendarDraft({ action, accountId: targetAccountId, calendars });
    } catch (err) {
      reportError("Could not prepare calendar event", err);
    }
  }, [selectedCalendarAccountId, accountId, activeAccountId, accounts]);

  const handleCreateEvent = useCallback(async (draft: CalendarEventDraft) => {
    if (!calendarDraft) return;
    try {
      await createCalendarEvent(calendarDraft.accountId, calendarDraft.calendars, draft);
      setCalendarDraft(null);
      notify("success", "Calendar event created", draft.summary);
    } catch (err) {
      reportError("Could not create calendar event", err);
    }
  }, [calendarDraft]);

  const handleAlwaysLoad = useCallback(async () => {
    if (accountId && senderAddress) {
      await addToAllowlist(accountId, senderAddress);
    }
    setOverrideShow(true);
  }, [accountId, senderAddress]);

  return (
    <div>
      {blocked && (
        <div className="flex items-center gap-2 px-3 py-2 mb-2 text-xs bg-bg-tertiary rounded-md border border-border-secondary">
          <ImageOff size={14} className="text-text-tertiary shrink-0" />
          <span className="text-text-secondary">
            Images hidden to protect your privacy.
          </span>
          <button
            onClick={handleLoadImages}
            className="text-accent hover:text-accent-hover font-medium"
          >
            Load images
          </button>
          {senderAddress && accountId && (
            <button
              onClick={handleAlwaysLoad}
              className="text-accent hover:text-accent-hover font-medium"
            >
              Always load from sender
            </button>
          )}
        </div>
      )}
      <iframe
        ref={iframeRef}
        sandbox={EMAIL_FRAME_SANDBOX}
        className={`w-full border-0 ${isDark && !isPlainText ? "rounded-md" : ""}`}
        style={{ overflow: "hidden" }}
        title="Email content"
      />
      {pendingLink && (
        <LinkConfirmDialog
          linkAnalysis={pendingLink}
          onCancel={() => setPendingLink(null)}
          onConfirm={handleConfirmLink}
        />
      )}
      {dataMenu && (
        <EmailDataActionMenu
          action={dataMenu.action}
          position={dataMenu.position}
          onClose={() => setDataMenu(null)}
          onOpen={openExternal}
          onCopy={(value) => { void handleCopy(value); }}
          onCompose={handleCompose}
          onAddContact={(email, name) => { void handleAddContact(email, name); }}
          onCreateEvent={(action) => { void handleBeginCreateEvent(action); }}
        />
      )}
      {calendarDraft && (
        <EventCreateModal
          calendars={calendarDraft.calendars}
          initialValues={{
            summary: "Event from email",
            description: `Created from date in email: ${calendarDraft.action.value}`,
            startTime: calendarDraft.action.startTime,
            endTime: calendarDraft.action.endTime,
          }}
          onClose={() => setCalendarDraft(null)}
          onCreate={handleCreateEvent}
        />
      )}
    </div>
  );
}
