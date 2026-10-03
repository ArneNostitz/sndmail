import { useState, useEffect, useCallback } from "react";
import { X, Mail, ExternalLink } from "lucide-react";
import { getMessagesForThread, type DbMessage } from "@/services/db/messages";
import { getThreadById, getThreadLabelIds } from "@/services/db/threads";
import { useThreadStore } from "@/stores/threadStore";
import { navigateToThread } from "@/router/navigate";
import { formatFullDate } from "@/utils/date";
import { useTimeFormat } from "@/hooks/useTimeFormat";
import { EmailRenderer } from "@/components/email/EmailRenderer";

import { Tooltip } from "@/components/ui/Tooltip";
interface TaskEmailSidebarProps {
  accountId: string;
  threadId: string;
  onClose: () => void;
}

/**
 * Reference panel on the Tasks page: shows the email thread a selected task
 * was created from, so the task can be worked without leaving the page.
 */
export function TaskEmailSidebar({ accountId, threadId, onClose }: TaskEmailSidebarProps) {
  // Repaint when the 12/24-hour preference changes
  useTimeFormat();
  const [messages, setMessages] = useState<DbMessage[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getMessagesForThread(accountId, threadId)
      .then((msgs) => {
        if (cancelled) return;
        setMessages(msgs);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setMessages([]);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [accountId, threadId]);

  // Mirrors ContactSidebar: make sure the thread is in the store before navigating
  const handleOpenInInbox = useCallback(async () => {
    const { threads, threadMap, setThreads } = useThreadStore.getState();
    if (!threadMap.has(threadId)) {
      const dbThread = await getThreadById(accountId, threadId);
      if (!dbThread) return;
      const labelIds = await getThreadLabelIds(accountId, threadId);
      setThreads([
        ...threads,
        {
          id: dbThread.id,
          accountId: dbThread.account_id,
          subject: dbThread.subject,
          snippet: dbThread.snippet,
          lastMessageAt: dbThread.last_message_at ?? 0,
          messageCount: dbThread.message_count,
          isRead: dbThread.is_read === 1,
          isStarred: dbThread.is_starred === 1,
          isPinned: dbThread.is_pinned === 1,
          isMuted: dbThread.is_muted === 1,
          hasAttachments: dbThread.has_attachments === 1,
          labelIds,
          fromName: dbThread.from_name,
          fromAddress: dbThread.from_address,
        },
      ]);
    }
    navigateToThread(threadId);
  }, [accountId, threadId]);

  const lastMessage = messages[messages.length - 1];

  return (
    <div className="w-96 border-l border-border-primary bg-bg-primary/50 flex flex-col shrink-0 min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-secondary shrink-0">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-text-primary">
          <Mail size={14} className="text-accent" />
          Linked email
        </h3>
        <div className="flex items-center gap-1">
          <Tooltip content="Open in inbox"><button
            onClick={handleOpenInInbox}

            className="p-1 text-text-tertiary hover:text-text-primary transition-colors"
          >
            <ExternalLink size={13} />
          </button></Tooltip>
          <button
            onClick={onClose}
            className="p-1 text-text-tertiary hover:text-text-primary transition-colors"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {loading ? (
          <p className="text-xs text-text-tertiary text-center py-8">Loading...</p>
        ) : !lastMessage ? (
          <p className="text-xs text-text-tertiary text-center py-8">
            The linked email is no longer available
          </p>
        ) : (
          <div className="p-4">
            <h4 className="text-sm font-semibold text-text-primary mb-1">
              {lastMessage.subject ?? "(No subject)"}
            </h4>
            <p className="text-xs text-text-secondary">
              {lastMessage.from_name ?? lastMessage.from_address ?? "Unknown"}
            </p>
            <p className="text-xs text-text-tertiary mb-3">
              {formatFullDate(lastMessage.date)}
              {messages.length > 1 && ` · ${messages.length} messages in thread`}
            </p>
            <div className="border-t border-border-secondary pt-3">
              <EmailRenderer
                html={lastMessage.body_html}
                text={lastMessage.body_text}
                blockImages={true}
                senderAddress={lastMessage.from_address}
                accountId={accountId}
                messageId={lastMessage.id}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
