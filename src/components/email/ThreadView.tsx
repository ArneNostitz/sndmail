import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { MessageItem } from "./MessageItem";
import type { EmailSelectionRequest } from "./EmailRenderer";
import { ActionBar } from "./ActionBar";
import { getMessagesForThreads, type DbMessage } from "@/services/db/messages";
import { useAccountStore } from "@/stores/accountStore";
import { useUIStore } from "@/stores/uiStore";
import { useThreadStore, type Thread } from "@/stores/threadStore";
import { getMergedThreadIds, unmergeThread } from "@/services/db/threads";
import { useComposerStore } from "@/stores/composerStore";
import { useContextMenuStore } from "@/stores/contextMenuStore";
import { markThreadRead, spamThread } from "@/services/emailActions";
import { getSetting } from "@/services/db/settings";
import { getAllowlistedSenders } from "@/services/db/imageAllowlist";
import { VolumeX, Merge } from "lucide-react";
import { escapeHtml, sanitizeHtml } from "@/utils/sanitize";
import { isNoReplyAddress } from "@/utils/noReply";
import { recipientHeadersFromMessages } from "@/utils/resolveFromAddress";
import { extractEmailAddresses } from "@/utils/emailUtils";
import { ThreadSummary } from "./ThreadSummary";
import { ChatThread } from "./ChatThread";
import { PastConversations } from "./PastConversations";
import { useOwnAddresses } from "@/hooks/useOwnAddresses";
import { SmartReplySuggestions } from "./SmartReplySuggestions";
import { InlineReply } from "./InlineReply";
import { ContactSidebar } from "./ContactSidebar";
import { TaskSidebar } from "@/components/tasks/TaskSidebar";
import { AiTaskExtractDialog } from "@/components/tasks/AiTaskExtractDialog";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { MessageSkeleton } from "@/components/ui/Skeleton";
import { RawMessageModal } from "./RawMessageModal";
import { formatDateTime } from "@/utils/date";
import { getBodySearchTerms } from "@/utils/searchHighlight";
import { SpamBanner } from "./SpamBanner";
import { reportError, notify } from "@/stores/toastStore";
import { useMailLinkStore } from "@/stores/mailLinkStore";

interface ThreadViewProps {
  thread: Thread;
}

async function handlePopOut(thread: Thread) {
  try {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const windowLabel = `thread-${thread.id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    const url = `index.html?thread=${encodeURIComponent(thread.id)}&account=${encodeURIComponent(thread.accountId)}`;

    // Check if window already exists
    const existing = await WebviewWindow.getByLabel(windowLabel);
    if (existing) {
      await existing.setFocus();
      return;
    }

    const win = new WebviewWindow(windowLabel, {
      url,
      title: thread.subject ?? "Thread",
      width: 800,
      height: 700,
      center: true,
      dragDropEnabled: false,
    });

    win.once("tauri://error", (e) => {
      console.error("Failed to create pop-out window:", e);
    });
  } catch (err) {
    console.error("Failed to open pop-out window:", err);
  }
}

export function ThreadView({ thread }: ThreadViewProps) {
  const fallbackAccountId = useAccountStore((s) => s.activeAccountId);
  // The unified list can open a thread from any mailbox, so every read and
  // action here has to follow the thread's own account rather than the one
  // selected in the sidebar.
  const threadAccountId = thread.accountId || fallbackAccountId;
  const contactSidebarVisible = useUIStore((s) => s.contactSidebarVisible);
  const threadViewMode = useUIStore((s) => s.threadViewMode);
  const setThreadViewMode = useUIStore((s) => s.setThreadViewMode);
  const toggleContactSidebar = useUIStore((s) => s.toggleContactSidebar);
  const taskSidebarVisible = useUIStore((s) => s.taskSidebarVisible);
  // Which side of the chat view a message sits on
  const ownAddressScope = useMemo(
    () => (threadAccountId ? [threadAccountId] : []),
    [threadAccountId],
  );
  const ownAddresses = useOwnAddresses(ownAddressScope);
  const [showTaskExtract, setShowTaskExtract] = useState(false);
  const updateThread = useThreadStore((s) => s.updateThread);
  const searchQuery = useThreadStore((s) => s.searchQuery);
  const searchMatch = useThreadStore((s) => s.searchMatches.get(thread.id));
  const bodySearchTerms = useMemo(
    () => getBodySearchTerms(searchQuery),
    [searchQuery],
  );
  const [messages, setMessages] = useState<DbMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const markedReadRef = useRef<string | null>(null);
  // null = not yet loaded; defer iframe rendering until setting is known
  const [blockImages, setBlockImages] = useState<boolean | null>(null);
  const [allowlistedSenders, setAllowlistedSenders] = useState<Set<string>>(new Set());
  const [restoringFromSpam, setRestoringFromSpam] = useState(false);
  const isSpam = thread.labelIds.includes("SPAM");

  const handleNotSpam = async () => {
    if (!threadAccountId || restoringFromSpam) return;
    setRestoringFromSpam(true);
    try {
      const result = await spamThread(threadAccountId, thread.id, [], false);
      if (!result.success) {
        reportError("Could not move conversation out of Spam", result.error);
        return;
      }
      updateThread(thread.id, {
        labelIds: [
          ...new Set([
            ...thread.labelIds.filter((labelId) => labelId !== "SPAM"),
            "INBOX",
          ]),
        ],
      });
      notify(
        "success",
        "Moved to Inbox",
        result.queued ? "The change will sync when you are back online." : undefined,
      );
    } catch (err) {
      reportError("Could not move conversation out of Spam", err);
    } finally {
      setRestoringFromSpam(false);
    }
  };

  // Preload settings eagerly on mount (parallel with message loading)
  useEffect(() => {
    getSetting("block_remote_images").then((val) => setBlockImages(val !== "false")).catch(() => setBlockImages(true));
  }, []);

  // Threads the user folded into this one — shown here, not as rows of their own
  const [mergedIds, setMergedIds] = useState<string[]>([]);

  // Load messages, including any conversation merged into this one
  const reloadMessages = useCallback(async () => {
    if (!threadAccountId) return;
    const merged = await getMergedThreadIds(threadAccountId, thread.id);
    setMergedIds(merged);
    const all = await getMessagesForThreads(threadAccountId, [thread.id, ...merged]);
    setMessages(all);
  }, [threadAccountId, thread.id]);

  useEffect(() => {
    if (!threadAccountId) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    const timeout = setTimeout(() => {
      if (!cancelled) { cancelled = true; setLoadError("Loading this email took too long. Please retry."); setLoading(false); }
    }, 15000);
    (async () => {
      try {
        const merged = await getMergedThreadIds(threadAccountId, thread.id);
        const all = await getMessagesForThreads(threadAccountId, [thread.id, ...merged]);
        if (!cancelled) { setMergedIds(merged); setMessages(all); }
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      } finally {
        clearTimeout(timeout);
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; clearTimeout(timeout); };
  }, [threadAccountId, thread.id, loadAttempt]);

  // Check per-sender allowlist (single batch query instead of N queries)
  useEffect(() => {
    if (!threadAccountId || messages.length === 0) return;
    let cancelled = false;

    const senders: string[] = [];
    for (const msg of messages) {
      if (msg.from_address) senders.push(msg.from_address);
    }
    const uniqueSenders = [...new Set(senders)];

    getAllowlistedSenders(threadAccountId, uniqueSenders).then((allowed) => {
      if (!cancelled) setAllowlistedSenders(allowed);
    });

    return () => { cancelled = true; };
  }, [threadAccountId, messages]);

  // Auto-mark unread threads as read when opened (respects mark-as-read setting)
  const markAsReadBehavior = useUIStore((s) => s.markAsReadBehavior);
  useEffect(() => {
    if (!threadAccountId || thread.isRead || markedReadRef.current === thread.id) return;
    if (markAsReadBehavior === "manual") return;

    const markRead = () => {
      markedReadRef.current = thread.id;
      markThreadRead(threadAccountId, thread.id, [], true).catch((err) => {
        console.error("Failed to mark thread as read:", err);
      });
    };

    if (markAsReadBehavior === "2s") {
      const timer = setTimeout(markRead, 2000);
      return () => clearTimeout(timer);
    }

    // instant
    markRead();
  }, [threadAccountId, thread.id, thread.isRead, updateThread, markAsReadBehavior]);

  const openComposer = useComposerStore((s) => s.openComposer);
  const openMenu = useContextMenuStore((s) => s.openMenu);
  const defaultReplyMode = useUIStore((s) => s.defaultReplyMode);
  const lastMessage = messages[messages.length - 1];

  const handleReply = useCallback(() => {
    if (!lastMessage) return;
    const replyTo = lastMessage.reply_to ?? lastMessage.from_address;
    openComposer({
      mode: "reply",
      to: replyTo ? [replyTo] : [],
      subject: `Re: ${lastMessage.subject ?? ""}`,
      bodyHtml: buildQuote(lastMessage),
      threadId: lastMessage.thread_id,
      inReplyToMessageId: lastMessage.id,
      originalRecipients: recipientHeadersFromMessages(messages),
      accountId: threadAccountId,
    });
  }, [lastMessage, messages, threadAccountId, openComposer]);

  const handleReplyAll = useCallback(() => {
    if (!lastMessage) return;
    const replyTo = lastMessage.reply_to ?? lastMessage.from_address;
    const allRecipients = new Set<string>();
    if (replyTo) allRecipients.add(replyTo);
    if (lastMessage.to_addresses) {
      lastMessage.to_addresses.split(",").forEach((a) => allRecipients.add(a.trim()));
    }
    const ccList: string[] = [];
    if (lastMessage.cc_addresses) {
      lastMessage.cc_addresses.split(",").forEach((a) => ccList.push(a.trim()));
    }
    openComposer({
      mode: "replyAll",
      to: Array.from(allRecipients),
      cc: ccList,
      subject: `Re: ${lastMessage.subject ?? ""}`,
      bodyHtml: buildQuote(lastMessage),
      threadId: lastMessage.thread_id,
      inReplyToMessageId: lastMessage.id,
      originalRecipients: recipientHeadersFromMessages(messages),
      accountId: threadAccountId,
    });
  }, [lastMessage, messages, threadAccountId, openComposer]);

  const handleForward = useCallback(() => {
    if (!lastMessage) return;
    openComposer({
      mode: "forward",
      to: [],
      subject: `Fwd: ${lastMessage.subject ?? ""}`,
      bodyHtml: buildForwardQuote(lastMessage),
      threadId: lastMessage.thread_id,
      inReplyToMessageId: lastMessage.id,
      originalRecipients: recipientHeadersFromMessages(messages),
      accountId: threadAccountId,
    });
  }, [lastMessage, messages, threadAccountId, openComposer]);

  const handlePrint = useCallback(() => {
    if (messages.length === 0) return;
    const iframe = document.createElement("iframe");
    iframe.style.position = "fixed";
    iframe.style.left = "-9999px";
    iframe.style.top = "-9999px";
    iframe.style.width = "0";
    iframe.style.height = "0";
    document.body.appendChild(iframe);

    const doc = iframe.contentDocument ?? iframe.contentWindow?.document;
    if (!doc) { document.body.removeChild(iframe); return; }

    const messagesHtml = messages.map((msg) => {
      const date = formatDateTime(msg.date);
      const from = msg.from_name
        ? `${escapeHtml(msg.from_name)} &lt;${escapeHtml(msg.from_address ?? "")}&gt;`
        : escapeHtml(msg.from_address ?? "Unknown");
      const to = escapeHtml(msg.to_addresses ?? "");
      const body = msg.body_html ? sanitizeHtml(msg.body_html) : escapeHtml(msg.body_text ?? "");
      return `
        <div style="margin-bottom:24px;padding-bottom:16px;border-bottom:1px solid #e5e5e5">
          <div style="margin-bottom:8px;color:#666;font-size:12px">
            <strong>From:</strong> ${from}<br/>
            <strong>To:</strong> ${to}<br/>
            <strong>Date:</strong> ${date}
          </div>
          <div>${body}</div>
        </div>`;
    }).join("");

    const safeSubject = escapeHtml(thread.subject ?? "");
    doc.open();
    doc.write(`<!DOCTYPE html><html><head><title>${safeSubject || "Email"}</title>
      <style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:800px;margin:20px auto;color:#333;font-size:14px}
      h1{font-size:18px;margin-bottom:8px}img{max-width:100%}</style></head>
      <body><h1>${safeSubject || "(No subject)"}</h1>${messagesHtml}</body></html>`);
    doc.close();

    iframe.contentWindow?.focus();
    iframe.contentWindow?.print();
    setTimeout(() => document.body.removeChild(iframe), 1000);
  }, [messages, thread.subject]);

  // Message-level keyboard navigation (ArrowUp / ArrowDown)
  const [focusedMsgIdx, setFocusedMsgIdx] = useState(-1);
  const messageRefs = useRef<(HTMLDivElement | null)[]>([]);
  const mailLinkTarget = useMailLinkStore((state) => state.target);

  // Reset before applying a queued external message selection.
  useEffect(() => {
    setFocusedMsgIdx(-1);
  }, [thread.id]);

  useEffect(() => {
    if (loading || !mailLinkTarget || mailLinkTarget.accountId !== threadAccountId ||
      mailLinkTarget.threadId !== thread.id) return;
    const index = mailLinkTarget.messageId ? messages.findIndex((message) => message.id === mailLinkTarget.messageId) : messages.length - 1;
    if (index < 0) return;
    setFocusedMsgIdx(index);
    const frame = requestAnimationFrame(() => {
      messageRefs.current[index]?.scrollIntoView({ block: "center", behavior: "auto" });
      useMailLinkStore.getState().consumed(mailLinkTarget);
    });
    return () => cancelAnimationFrame(frame);
  }, [mailLinkTarget, loading, messages, thread.id, threadAccountId, threadViewMode]);

  // Scroll focused message into view
  useEffect(() => {
    if (focusedMsgIdx >= 0 && messageRefs.current[focusedMsgIdx]) {
      messageRefs.current[focusedMsgIdx]!.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [focusedMsgIdx]);

  // Arrow key handler for message navigation (only in full-screen thread view)
  // In split-pane mode, arrows navigate the thread list instead (handled by useKeyboardShortcuts)
  const readingPanePosition = useUIStore((s) => s.readingPanePosition);
  useEffect(() => {
    if (readingPanePosition !== "hidden") return;

    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInputFocused =
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable;
      if (isInputFocused) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocusedMsgIdx((prev) => {
          const next = prev + 1;
          return next < messages.length ? next : prev;
        });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocusedMsgIdx((prev) => {
          const next = prev - 1;
          return next >= 0 ? next : prev;
        });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [messages.length, readingPanePosition]);

  const [rawMessageTarget, setRawMessageTarget] = useState<{
    messageId: string;
    accountId: string;
  } | null>(null);

  // A merge made anywhere — the list bar, the history below — changes what
  // this thread contains
  useEffect(() => {
    const handler = () => { reloadMessages().catch(console.error); };
    window.addEventListener("snd-threads-merged", handler);
    return () => window.removeEventListener("snd-threads-merged", handler);
  }, [reloadMessages]);

  // Listen for "View Source" event from context menu
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        messageId: string;
        accountId: string;
      };
      setRawMessageTarget(detail);
    };
    window.addEventListener("snd-view-raw-message", handler);
    return () => window.removeEventListener("snd-view-raw-message", handler);
  }, []);

  // Listen for extract-task event from keyboard shortcut
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { threadId: string } | undefined;
      if (detail?.threadId === thread.id) {
        setShowTaskExtract(true);
      }
    };
    window.addEventListener("snd-extract-task", handler);
    return () => window.removeEventListener("snd-extract-task", handler);
  }, [thread.id]);

  const handleMessageContextMenu = useCallback((e: React.MouseEvent, msg: DbMessage) => {
    e.preventDefault();
    openMenu("message", { x: e.clientX, y: e.clientY }, {
      messageId: msg.id,
      threadId: msg.thread_id,
      accountId: msg.account_id,
      fromAddress: msg.from_address,
      fromName: msg.from_name,
      replyTo: msg.reply_to,
      toAddresses: msg.to_addresses,
      ccAddresses: msg.cc_addresses,
      subject: msg.subject,
      date: msg.date,
      bodyHtml: msg.body_html,
      bodyText: msg.body_text,
    });
  }, [openMenu]);

  const handleSelectionContextMenu = useCallback((msg: DbMessage, request: EmailSelectionRequest) => {
    openMenu("textSelection", request.position, {
      accountId: msg.account_id,
      threadId: msg.thread_id,
      text: request.text,
      contextMenu: request.contextMenu,
    });
  }, [openMenu]);

  const handleExport = useCallback(async () => {
    if (messages.length === 0) return;
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");

      const emlParts = messages.map((msg) => {
        const date = new Date(msg.date).toUTCString();
        const from = msg.from_name
          ? `${msg.from_name} <${msg.from_address}>`
          : (msg.from_address ?? "");
        const lines = [
          `From: ${from}`,
          `To: ${msg.to_addresses ?? ""}`,
          msg.cc_addresses ? `Cc: ${msg.cc_addresses}` : null,
          `Subject: ${msg.subject ?? ""}`,
          `Date: ${date}`,
          `Message-ID: <${msg.id}>`,
          `MIME-Version: 1.0`,
          `Content-Type: text/html; charset=UTF-8`,
          ``,
          msg.body_html ?? msg.body_text ?? "",
        ].filter((l): l is string => l !== null);
        return lines.join("\r\n");
      });

      const content = emlParts.join("\r\n\r\n");
      const defaultName = `${(thread.subject ?? "email").replace(/[^a-zA-Z0-9_-]/g, "_")}.eml`;

      const filePath = await save({
        defaultPath: defaultName,
        filters: [{ name: "Email", extensions: ["eml"] }],
      });
      if (filePath) {
        await writeTextFile(filePath, content);
      }
    } catch (err) {
      console.error("Failed to export thread:", err);
    }
  }, [messages, thread.subject]);

  // While a contact is pinned the sidebar stays with them, so clicking through
  // their past conversations does not swap it out from under the user.
  // Must sit above the early return below — hooks cannot be conditional.
  const pinnedContact = useUIStore((s) => s.pinnedContact);

  if (loadError) {
    return <div className="p-6" role="alert"><p>Could not open this email</p><p className="text-sm text-text-secondary">{loadError}</p><button className="mt-3 text-accent underline" onClick={() => setLoadAttempt((n) => n + 1)}>Retry</button></div>;
  }
  if (loading) {
    return (
      <div className="flex flex-col h-full">
        <MessageSkeleton />
        <MessageSkeleton />
        <MessageSkeleton />
      </div>
    );
  }

  // Detect no-reply senders — disable reply buttons but still allow forward
  const noReply = isNoReplyAddress(lastMessage?.reply_to ?? lastMessage?.from_address);

  // The other side of the conversation — who the sidebar and the history are
  // about. Taking the last sender instead put the user's own alias there
  // whenever they wrote last, so the panel profiled the user and listed every
  // unrelated thread they had sent from that address.
  const isMine = (address: string | null | undefined) =>
    !!address && ownAddresses.has(address.toLowerCase());
  const peerMessage = [...messages].reverse().find((m) => m.from_address && !isMine(m.from_address));
  // A thread the user only sent into names its peer in the recipients
  const peerFromRecipients = [...messages]
    .reverse()
    .flatMap((m) => extractEmailAddresses(m.to_addresses))
    .find((address) => !isMine(address)) ?? null;
  // A pinned contact must never override this with the user's own address —
  // that pulls every mail addressed to the account into "earlier with".
  const pinnedPeer = pinnedContact && !isMine(pinnedContact.email) ? pinnedContact : null;
  const peerAddress = pinnedPeer?.email ?? peerMessage?.from_address ?? peerFromRecipients;
  const peerName = pinnedPeer?.name ?? (peerMessage ? peerMessage.from_name : null);

  return (
    <div className="flex h-full @container relative">
      <div className="flex flex-col flex-1 min-w-0 pr-[51px]">
        {/* Unified action bar */}
        <ActionBar
          thread={thread}
          messages={messages}
          noReply={noReply}
          defaultReplyMode={defaultReplyMode}
          contactSidebarVisible={contactSidebarVisible}
          taskSidebarVisible={taskSidebarVisible}
          onReply={handleReply}
          onReplyAll={handleReplyAll}
          onForward={handleForward}
          onPrint={handlePrint}
          onExport={handleExport}
          onPopOut={() => handlePopOut(thread)}
          onToggleContactSidebar={toggleContactSidebar}
          onToggleTaskSidebar={() => useUIStore.getState().toggleTaskSidebar()}
          threadViewMode={threadViewMode}
          onToggleThreadViewMode={() =>
            setThreadViewMode(threadViewMode === "chat" ? "classic" : "chat")
          }
        />

        {isSpam && (
          <SpamBanner onNotSpam={handleNotSpam} restoring={restoringFromSpam} />
        )}

        {/* Merged conversations — say so, and offer the way out */}
        {mergedIds.length > 0 && threadAccountId && (
          <div className="flex items-center gap-2 px-[18px] py-2 bg-accent/5 border-b border-border-secondary text-xs text-text-secondary">
            <Merge size={13} className="shrink-0 text-accent" />
            <span className="flex-1">
              {mergedIds.length} other conversation{mergedIds.length === 1 ? "" : "s"} merged into this one
            </span>
            <button
              onClick={async () => {
                for (const id of mergedIds) {
                  await unmergeThread(threadAccountId, id).catch(console.error);
                }
                await reloadMessages().catch(console.error);
                window.dispatchEvent(new CustomEvent("snd-threads-merged"));
              }}
              className="text-accent hover:underline shrink-0"
            >
              Separate again
            </button>
          </div>
        )}

        {/* Thread subject */}
        <div className="px-[18px] py-8 bg-gradient-to-br from-white/55 to-transparent dark:from-white/[0.02]">
          <h1 className="font-serif text-3xl font-semibold tracking-[-0.025em] text-text-primary flex items-center gap-2">
            {thread.subject ?? "(No subject)"}
            {thread.isMuted && (
              <span className="text-warning shrink-0" title="Muted">
                <VolumeX size={16} />
              </span>
            )}
          </h1>
          <div className="text-xs text-text-tertiary mt-2">
            {messages.length} message{messages.length !== 1 ? "s" : ""} in this thread
          </div>
        </div>

        {/* AI Summary */}
        {threadAccountId && (
          <ThreadSummary
            threadId={thread.id}
            accountId={threadAccountId}
            messages={messages}
          />
        )}

        {/* Messages */}
        <div className="flex-1 overflow-y-auto">
          <ErrorBoundary name="MessageList">
            {threadViewMode === "chat" ? (
              <ChatThread
                messages={messages}
                ownAddresses={ownAddresses}
                blockImages={blockImages}
                allowlistedSenders={allowlistedSenders}
                isSpam={isSpam}
                onMessageContextMenu={handleMessageContextMenu}
                onSelectionContextMenu={handleSelectionContextMenu}
                searchMessageIds={searchMatch?.messageIds}
                highlightTerms={bodySearchTerms}
                focusedMessageId={messages[focusedMsgIdx]?.id}
                messageRef={(index, element) => { messageRefs.current[index] = element; }}
              />
            ) : (
              messages.map((msg, i) => (
                <MessageItem
                  key={msg.id}
                  ref={(el) => { messageRefs.current[i] = el; }}
                  message={msg}
                  isLast={i === messages.length - 1}
                  focused={i === focusedMsgIdx}
                  blockImages={blockImages}
                  senderAllowlisted={msg.from_address ? allowlistedSenders.has(msg.from_address) : false}
                  isSpam={isSpam}
                  ownAddresses={ownAddresses}
                  isSearchMatch={searchMatch?.messageIds.has(msg.id)}
                  highlightTerms={bodySearchTerms}
                  onContextMenu={(e) => handleMessageContextMenu(e, msg)}
                  onSelectionContextMenu={(request) => handleSelectionContextMenu(msg, request)}
                />
              ))
            )}
          </ErrorBoundary>

          {/* Smart Reply Suggestions */}
          {threadAccountId && messages.length > 0 && (
            <SmartReplySuggestions
              threadId={thread.id}
              accountId={threadAccountId}
              messages={messages}
              noReply={noReply}
            />
          )}

          {/* Inline Reply */}
          {threadAccountId && (
            <InlineReply
              thread={thread}
              messages={messages}
              accountId={threadAccountId}
              noReply={noReply}
              onSent={() => {
                reloadMessages().catch(console.error);
              }}
            />
          )}

          {/* The rest of the correspondence with this person, so the whole
              history is one scroll rather than a sidebar full of links */}
          {threadAccountId && peerAddress && ownAddresses.size > 0 && (
            <PastConversations
              accountId={threadAccountId}
              email={peerAddress}
              name={peerName}
              currentThreadId={thread.id}
              viewMode={threadViewMode}
              ownAddresses={ownAddresses}
              blockImages={blockImages}
              allowlistedSenders={allowlistedSenders}
            />
          )}
        </div>
      </div>

      {/* Contact sidebar — overlay at narrow widths, inline at wide */}
      {contactSidebarVisible && peerAddress && threadAccountId && (
        <>
          {/* Backdrop for overlay mode (narrow widths) */}
          <div
            className="absolute inset-0 z-10 bg-black/20 @[640px]:hidden"
            onClick={toggleContactSidebar}
          />
          <div className="absolute right-0 top-0 bottom-0 z-20 shadow-xl @[640px]:relative @[640px]:z-auto @[640px]:shadow-none">
            <ContactSidebar
              email={peerAddress}
              name={peerName}
              accountId={threadAccountId}
              threadId={thread.id}
              ownAddresses={ownAddresses}
              onClose={toggleContactSidebar}
            />
          </div>
        </>
      )}

      {/* Task companion — a gentle overlay in compact spaces and part of the
          workspace once there is enough room for the message and the task. */}
      {taskSidebarVisible && threadAccountId && (
        <>
          <div
            className="absolute inset-0 z-20 bg-stone-950/15 backdrop-blur-[1px] @[1050px]:hidden"
            onClick={() => useUIStore.getState().toggleTaskSidebar()}
          />
          <div className="task-panel-enter absolute inset-y-2 right-14 z-30 @[1050px]:relative @[1050px]:inset-auto @[1050px]:z-auto @[1050px]:my-2 @[1050px]:mr-2">
            <TaskSidebar accountId={threadAccountId} threadId={thread.id} />
          </div>
        </>
      )}

      {/* Raw message source modal */}
      {rawMessageTarget && (
        <RawMessageModal
          isOpen={true}
          onClose={() => setRawMessageTarget(null)}
          messageId={rawMessageTarget.messageId}
          accountId={rawMessageTarget.accountId}
        />
      )}

      {/* AI Task Extraction Dialog */}
      {showTaskExtract && threadAccountId && (
        <AiTaskExtractDialog
          threadId={thread.id}
          accountId={threadAccountId}
          messages={messages}
          onClose={() => setShowTaskExtract(false)}
        />
      )}
    </div>
  );
}

function buildQuote(msg: DbMessage): string {
  const date = formatDateTime(msg.date);
  const from = msg.from_name
    ? `${escapeHtml(msg.from_name)} &lt;${escapeHtml(msg.from_address ?? "")}&gt;`
    : escapeHtml(msg.from_address ?? "Unknown");
  const body = msg.body_html ? sanitizeHtml(msg.body_html) : escapeHtml(msg.body_text ?? "");
  return `<br><br><div style="border-left:2px solid #ccc;padding-left:12px;margin-left:0;color:#666">On ${date}, ${from} wrote:<br>${body}</div>`;
}

function buildForwardQuote(msg: DbMessage): string {
  const date = formatDateTime(msg.date);
  const body = msg.body_html ? sanitizeHtml(msg.body_html) : escapeHtml(msg.body_text ?? "");
  return `<br><br>---------- Forwarded message ---------<br>From: ${escapeHtml(msg.from_name ?? "")} &lt;${escapeHtml(msg.from_address ?? "")}&gt;<br>Date: ${date}<br>Subject: ${escapeHtml(msg.subject ?? "")}<br>To: ${escapeHtml(msg.to_addresses ?? "")}<br><br>${body}`;
}
