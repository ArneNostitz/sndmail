import { memo, useMemo } from "react";
import { useDraggable } from "@dnd-kit/core";
import type { Thread } from "@/stores/threadStore";
import { useThreadStore } from "@/stores/threadStore";
import { useUIStore } from "@/stores/uiStore";
import { useActiveLabel } from "@/hooks/useRouteNavigation";
import { formatThreadListDate } from "@/utils/date";
import { useTimeFormat } from "@/hooks/useTimeFormat";
import { Paperclip, Star, Check, Pin, BellRing, VolumeX, CheckSquare } from "lucide-react";
import { SenderAvatar } from "./SenderAvatar";
import type { DragData } from "@/components/dnd/DndProvider";
import { useLabelStore } from "@/stores/labelStore";
import { useAccountStore } from "@/stores/accountStore";
import { accountColor } from "@/constants/accountColors";
import { threadFolder, type ThreadFolderId } from "@/utils/threadFolder";
import { HighlightedText } from "@/components/search/HighlightedText";

// A search result names where it lives. Trash and Spam shout: acting on a
// hit there is not the same as acting on one in the inbox.
const FOLDER_COLORS: Partial<Record<ThreadFolderId, string>> = {
  trash: "bg-bg-tertiary text-text-secondary",
  spam: "bg-bg-tertiary text-text-secondary",
  drafts: "bg-bg-tertiary text-text-secondary",
};

const CATEGORY_COLORS: Record<string, string> = {
  Updates: "bg-bg-tertiary text-text-secondary",
  Promotions: "bg-bg-tertiary text-text-secondary",
  Social: "bg-bg-tertiary text-text-secondary",
  Newsletters: "bg-bg-tertiary text-text-secondary",
};

interface ThreadCardProps {
  thread: Thread;
  isSelected: boolean;
  onClick: (thread: Thread) => void;
  onContextMenu?: (e: React.MouseEvent, threadId: string) => void;
  category?: string;
  showCategoryBadge?: boolean;
  hasFollowUp?: boolean;
  hasTask?: boolean;
  /** Tag the row with the folder it is in — for search hits, which can come from anywhere */
  showFolder?: boolean;
  /** Excerpt centered on the message-body match, instead of the thread's latest snippet. */
  searchExcerpt?: string | null;
  highlightTerms?: readonly string[];
}

export const ThreadCard = memo(function ThreadCard({ thread, isSelected, onClick, onContextMenu, category, showCategoryBadge, hasFollowUp, hasTask, showFolder, searchExcerpt, highlightTerms }: ThreadCardProps) {
  const isMultiSelected = useThreadStore((s) => s.selectedThreadIds.has(thread.id));
  const isRemoving = useThreadStore((s) => s.removingThreadIds.has(thread.id));
  const hasMultiSelect = useThreadStore((s) => s.selectedThreadIds.size > 0);
  const toggleThreadSelection = useThreadStore((s) => s.toggleThreadSelection);
  const selectThreadRange = useThreadStore((s) => s.selectThreadRange);
  const activeLabel = useActiveLabel();
  const emailDensity = useUIStore((s) => s.emailDensity);
  const accounts = useAccountStore((s) => s.accounts);
  const receivedAccountIndex = accounts.findIndex((account) => account.id === thread.accountId);
  const receivedAccount = receivedAccountIndex < 0 ? null : accounts[receivedAccountIndex]!;
  const receivedAccountColor = receivedAccount
    ? accountColor(receivedAccount.color, receivedAccountIndex)
    : null;
  // Repaint when the 12/24-hour preference changes
  useTimeFormat();
  const isSpam = thread.labelIds.includes("SPAM");
  // Names for user labels, so a hit filed under one says "Receipts" not "Archive"
  const labels = useLabelStore((s) => s.labels);
  const folder = useMemo(() => {
    if (!showFolder) return null;
    const names = new Map(labels.map((l) => [l.id, l.name]));
    const resolved = threadFolder(thread.labelIds, names);
    // Inbox is the expected location. The pill exists to call out mail that
    // lives somewhere else (Archive, Sent, a user label, etc.).
    return resolved.id === "inbox" ? null : resolved;
  }, [showFolder, labels, thread.labelIds]);

  // Read selectedThreadIds lazily for drag — avoids subscribing all cards to the Set reference
  const dragData: DragData = useMemo(() => ({
    threadIds: hasMultiSelect && isMultiSelected
      ? [...useThreadStore.getState().selectedThreadIds]
      : [thread.id],
    sourceLabel: activeLabel,
  }), [hasMultiSelect, isMultiSelected, thread.id, activeLabel]);

  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `thread-${thread.id}`,
    data: dragData,
  });

  const handleClick = (e: React.MouseEvent) => {
    if (e.shiftKey) {
      e.preventDefault();
      selectThreadRange(thread.id);
    } else if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      toggleThreadSelection(thread.id);
    } else if (hasMultiSelect) {
      toggleThreadSelection(thread.id);
    } else {
      onClick(thread);
    }
  };

  const handleContextMenu = onContextMenu
    ? (e: React.MouseEvent) => onContextMenu(e, thread.id)
    : undefined;

  return (
    <button
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      aria-label={`${thread.isRead ? "" : "Unread "}email from ${thread.fromName ?? thread.fromAddress ?? "Unknown"}: ${thread.subject ?? "(No subject)"}`}
      aria-selected={isSelected}
      className={`relative mx-1.5 my-0.5 w-[calc(100%-0.75rem)] rounded-lg px-2.5 text-left transition-colors duration-150 ${
        isRemoving ? "thread-exit " : ""
      }${
        emailDensity === "compact" ? "py-1.5" : emailDensity === "spacious" ? "py-2.5" : "py-2"
      } ${
        isDragging
          ? "opacity-50"
          : isMultiSelected
            ? "bg-bg-tertiary"
            : isSelected
              ? "bg-bg-tertiary"
              : "bg-bg-primary hover:bg-bg-hover"
      } ${isSpam ? "bg-red-500/8 dark:bg-red-500/10" : ""}`}
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {isMultiSelected ? (
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-bg-tertiary text-xs font-medium text-text-secondary">
              <Check size={emailDensity === "compact" ? 14 : 16} />
            </div>
          ) : (
            <SenderAvatar
              email={thread.fromAddress}
              name={thread.fromName}
              className="w-7 h-7 text-xs"
            />
          )}
          <span className={`truncate text-[0.8125rem] ${thread.isRead ? "text-text-secondary" : "font-semibold text-text-primary"}`}>
            {!thread.isRead && <span aria-hidden="true" className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-sky-500 align-middle" />}
            <HighlightedText
              text={thread.fromName ?? thread.fromAddress ?? "Unknown"}
              terms={highlightTerms}
            />
          </span>
        </div>
        <span className="flex shrink-0 items-center gap-1.5">
          {folder && (
            <span
              data-testid="thread-folder"
              className={`max-w-24 truncate whitespace-nowrap rounded-full px-1.5 text-[0.625rem] leading-normal ${FOLDER_COLORS[folder.id] ?? "bg-bg-tertiary text-text-secondary"}`}
              title={`In ${folder.name}`}
            >
              {folder.name}
            </span>
          )}
          <span className="whitespace-nowrap text-xs text-text-tertiary">
            {formatThreadListDate(thread.lastMessageAt)}
          </span>
          {receivedAccount && receivedAccountColor && (
            <span
              className="flex h-4 w-4 shrink-0 items-center justify-center overflow-hidden rounded-full text-[0.5rem] font-semibold text-white"
              style={{ backgroundColor: receivedAccountColor.hex }}
              title={`Received by ${receivedAccount.displayName || receivedAccount.email}`}
              aria-label={`Received by ${receivedAccount.displayName || receivedAccount.email}`}
            >
              {receivedAccount.avatarUrl ? (
                <img src={receivedAccount.avatarUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                (receivedAccount.displayName || receivedAccount.email).charAt(0).toUpperCase()
              )}
            </span>
          )}
        </span>
      </div>

      {/* Subject and preview use the full row width below the sender line. */}
      <div className={`mt-1 truncate text-[0.8125rem] ${thread.isRead ? "text-text-secondary" : "text-text-primary"}`}>
        <HighlightedText
          text={thread.subject ?? "(No subject)"}
          terms={highlightTerms}
        />
      </div>

      {/* Snippet + indicators */}
      <div className={`mt-0.5 flex items-center gap-1.5 ${emailDensity === "compact" ? "hidden" : ""}`}>
        <span className="flex-1 truncate text-[0.6875rem] text-text-tertiary">
          {/* Who spoke last — a thread waiting on them reads differently
              from one waiting on you */}
          {searchExcerpt == null && thread.lastFromMe && (
            <span
              className="mr-1 rounded px-1 py-px align-baseline font-medium text-text-secondary bg-bg-tertiary"
              title="You sent the last message"
            >
              me:
            </span>
          )}
          <HighlightedText
            text={searchExcerpt ?? thread.snippet}
            terms={highlightTerms}
          />
        </span>
        {showCategoryBadge && category && category !== "Primary" && CATEGORY_COLORS[category] && (
          <span className={`shrink-0 rounded-full px-1.5 text-[0.625rem] leading-normal ${CATEGORY_COLORS[category]}`}>
            {category}
          </span>
        )}
        {hasFollowUp && (
          <span className="shrink-0 text-text-tertiary" title="Follow-up reminder set">
            <BellRing size={12} />
          </span>
        )}
        {hasTask && (
          <span className="shrink-0 text-text-tertiary" title="Has an open task">
            <CheckSquare size={12} />
          </span>
        )}
        {thread.isMuted && (
          <span className="shrink-0 text-text-tertiary" title="Muted">
            <VolumeX size={12} />
          </span>
        )}
        {thread.isPinned && (
          <span className="shrink-0 text-text-tertiary" title="Pinned">
            <Pin size={12} className="fill-current" />
          </span>
        )}
        {thread.hasAttachments && (
          <span className="shrink-0 text-text-tertiary" title="Has attachments">
            <Paperclip size={12} />
          </span>
        )}
        {thread.isStarred && (
          <span className="star-animate shrink-0 text-text-tertiary" title="Starred">
            <Star size={12} className="fill-current" />
          </span>
        )}
        {thread.messageCount > 1 && (
          <span className="shrink-0 rounded-full bg-bg-tertiary px-1.5 text-xs text-text-tertiary">
            {thread.messageCount}
          </span>
        )}
      </div>

    </button>
  );
});
