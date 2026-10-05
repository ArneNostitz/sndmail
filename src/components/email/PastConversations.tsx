import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, History, Merge, ExternalLink } from "lucide-react";
import { getThreadsWithContact, mergeThreads, getThreadLabelIds, type DbThread } from "@/services/db/threads";
import { getMessagesForThreads, type DbMessage } from "@/services/db/messages";
import { formatRelativeDate } from "@/utils/date";
import { useTimeFormat } from "@/hooks/useTimeFormat";
import { useThreadStore } from "@/stores/threadStore";
import { navigateToThread } from "@/router/navigate";
import { MessageItem } from "./MessageItem";
import { ChatThread } from "./ChatThread";
import type { ThreadViewMode } from "@/stores/uiStore";

/** Threads fetched per page — a click loads the next batch. */
const PAGE_SIZE = 10;

interface PastConversationsProps {
  accountId: string;
  /** The person whose history this is. */
  email: string;
  name?: string | null;
  /** The thread already on screen above, which must not repeat here. */
  currentThreadId: string;
  viewMode: ThreadViewMode;
  ownAddresses: Set<string>;
  blockImages?: boolean | null;
  allowlistedSenders?: Set<string>;
}

/**
 * Everything else this person has written, hung under the open thread.
 *
 * The whole correspondence becomes one scroll: each earlier conversation
 * keeps its own heading, and every message in it is listed folded, so the
 * history can be scanned at a glance and opened where it matters.
 */
export function PastConversations({
  accountId,
  email,
  name,
  currentThreadId,
  viewMode,
  ownAddresses,
  blockImages,
  allowlistedSenders,
}: PastConversationsProps) {
  useTimeFormat();
  // A Set identity changes on every render of the parent; the addresses do not
  const ownAddressKey = [...ownAddresses].sort().join(",");
  const [threads, setThreads] = useState<DbThread[]>([]);
  const [messagesByThread, setMessagesByThread] = useState<Map<string, DbMessage[]>>(
    () => new Map(),
  );
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [hiddenThreadIds, setHiddenThreadIds] = useState<Set<string>>(() => new Set());

  const loadPage = useCallback(
    async (offset: number): Promise<{ rows: DbThread[]; msgs: DbMessage[] }> => {
      const rows = await getThreadsWithContact(
        accountId,
        email,
        currentThreadId,
        [...ownAddresses],
        PAGE_SIZE,
        offset,
      );
      const msgs = await getMessagesForThreads(accountId, rows.map((r) => r.id));
      return { rows, msgs };
    },
    [accountId, email, currentThreadId, ownAddressKey], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const mergeMessages = useCallback((msgs: DbMessage[]) => {
    setMessagesByThread((prev) => {
      const next = new Map(prev);
      for (const msg of msgs) {
        // A fresh array per thread — the old one may already be rendered
        next.set(msg.thread_id, [...(next.get(msg.thread_id) ?? []), msg]);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (!email || !accountId) return;
    let cancelled = false;
    setLoading(true);
    setThreads([]);
    setMessagesByThread(new Map());
    setHiddenThreadIds(new Set());

    loadPage(0)
      .then(({ rows, msgs }) => {
        if (cancelled) return;
        setThreads(rows);
        setHasMore(rows.length === PAGE_SIZE);
        mergeMessages(msgs);
      })
      .catch((err) => {
        console.error("Failed to load past conversations:", err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [accountId, email, currentThreadId, loadPage, mergeMessages]);

  const handleLoadMore = async () => {
    if (loadingMore) return;
    setLoadingMore(true);
    try {
      const { rows, msgs } = await loadPage(threads.length);
      setThreads((prev) => [...prev, ...rows]);
      setHasMore(rows.length === PAGE_SIZE);
      mergeMessages(msgs);
    } catch (err) {
      console.error("Failed to load more past conversations:", err);
    } finally {
      setLoadingMore(false);
    }
  };

  const toggleThread = (id: string) => {
    setHiddenThreadIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (loading || threads.length === 0) return null;

  const who = name ?? email;

  return (
    <div className="border-t-4 border-border-primary mt-2">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-bg-hover transition-colors"
      >
        {expanded ? <ChevronDown size={14} className="shrink-0 text-text-tertiary" /> : <ChevronRight size={14} className="shrink-0 text-text-tertiary" />}
        <History size={14} className="shrink-0 text-text-tertiary" />
        <span className="text-sm font-medium text-text-secondary truncate">
          Earlier with {who}
        </span>
        <span className="text-xs text-text-tertiary shrink-0">
          {threads.length}
          {hasMore ? "+" : ""} conversation{threads.length === 1 ? "" : "s"}
        </span>
      </button>

      {expanded && (
        <div>
          {threads.map((thread) => {
            const msgs = messagesByThread.get(thread.id) ?? [];
            const hidden = hiddenThreadIds.has(thread.id);
            return (
              <div key={thread.id} className="border-t border-border-secondary relative group/conv">
                <button
                  onClick={() => toggleThread(thread.id)}
                  className="w-full flex items-center gap-2 px-4 py-2 text-left bg-bg-tertiary/50 hover:bg-bg-hover transition-colors"
                >
                  {hidden ? <ChevronRight size={12} className="shrink-0 text-text-tertiary" /> : <ChevronDown size={12} className="shrink-0 text-text-tertiary" />}
                  <span className="text-xs font-medium text-text-secondary truncate flex-1">
                    {thread.subject ?? "(No subject)"}
                  </span>
                  <span className="text-[0.625rem] text-text-tertiary shrink-0">
                    {msgs.length || thread.message_count} msg
                    {(msgs.length || thread.message_count) === 1 ? "" : "s"}
                  </span>
                  {thread.last_message_at != null && (
                    <span className="text-[0.625rem] text-text-tertiary shrink-0">
                      {formatRelativeDate(thread.last_message_at)}
                    </span>
                  )}
                </button>

                {/* Open it properly — a folded history is for scanning, but
                    replying needs the real thread with its action bar */}
                <button
                  onClick={async () => {
                    try {
                      const labelIds = await getThreadLabelIds(accountId, thread.id);
                      // Cached rather than pushed into the list: opening a past
                      // conversation must not rearrange the mailbox behind it
                      useThreadStore.getState().cacheThread({
                        id: thread.id,
                        accountId: thread.account_id,
                        subject: thread.subject,
                        snippet: thread.snippet,
                        lastMessageAt: thread.last_message_at ?? 0,
                        messageCount: thread.message_count,
                        isRead: thread.is_read === 1,
                        isStarred: thread.is_starred === 1,
                        isPinned: thread.is_pinned === 1,
                        isMuted: thread.is_muted === 1,
                        hasAttachments: thread.has_attachments === 1,
                        labelIds,
                        fromName: thread.from_name,
                        fromAddress: thread.from_address,
                      });
                      navigateToThread(thread.id);
                    } catch (err) {
                      console.error("Failed to open conversation:", err);
                    }
                  }}
                  title="Open this conversation to reply"
                  className="absolute right-9 top-1.5 p-1 rounded text-text-tertiary hover:text-accent hover:bg-bg-hover opacity-0 group-hover/conv:opacity-100 transition-opacity"
                >
                  <ExternalLink size={12} />
                </button>

                {/* Merge from where the split is actually visible. Unlike the
                    list, this anchors on the thread being read rather than the
                    oldest — the open conversation is the one with context. */}
                <button
                  onClick={async () => {
                    try {
                      await mergeThreads(accountId, currentThreadId, [thread.id]);
                      window.dispatchEvent(new CustomEvent("snd-threads-merged"));
                    } catch (err) {
                      console.error("Failed to merge conversation:", err);
                    }
                  }}
                  title="Merge this into the conversation above"
                  className="absolute right-2 top-1.5 p-1 rounded text-text-tertiary hover:text-accent hover:bg-bg-hover opacity-0 group-hover/conv:opacity-100 transition-opacity"
                >
                  <Merge size={12} />
                </button>

                {!hidden && (
                  viewMode === "chat" ? (
                    <ChatThread
                      messages={msgs}
                      ownAddresses={ownAddresses}
                      blockImages={blockImages}
                      allowlistedSenders={allowlistedSenders}
                      hideToolbar
                      defaultCollapsed
                    />
                  ) : (
                    msgs.map((msg) => (
                      <MessageItem
                        key={msg.id}
                        message={msg}
                        isLast={false}
                        blockImages={blockImages}
                        senderAllowlisted={
                          msg.from_address ? allowlistedSenders?.has(msg.from_address) ?? false : false
                        }
                        ownAddresses={ownAddresses}
                      />
                    ))
                  )
                )}
              </div>
            );
          })}

          {hasMore && (
            <button
              onClick={handleLoadMore}
              disabled={loadingMore}
              className="w-full px-4 py-3 text-xs text-accent hover:bg-bg-hover transition-colors disabled:opacity-50"
            >
              {loadingMore ? "Loading..." : "Load earlier conversations"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
