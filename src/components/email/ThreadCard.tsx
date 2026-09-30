import { memo, useMemo } from "react";
import { useDraggable } from "@dnd-kit/core";
import type { Thread } from "@/stores/threadStore";
import { useThreadStore } from "@/stores/threadStore";
import { useUIStore } from "@/stores/uiStore";
import { useActiveLabel } from "@/hooks/useRouteNavigation";
import { formatRelativeDate } from "@/utils/date";
import { useTimeFormat } from "@/hooks/useTimeFormat";
import { Paperclip, Star, Check, Pin, BellRing, VolumeX, CheckSquare } from "lucide-react";
import { SenderAvatar } from "./SenderAvatar";
import type { DragData } from "@/components/dnd/DndProvider";
import { useLabelStore } from "@/stores/labelStore";
import { threadFolder, type ThreadFolderId } from "@/utils/threadFolder";
import { HighlightedText } from "@/components/search/HighlightedText";

// A search result names where it lives. Trash and Spam shout: acting on a
// hit there is not the same as acting on one in the inbox.
const FOLDER_COLORS: Partial<Record<ThreadFolderId, string>> = {
  trash: "bg-danger/15 text-danger",
  spam: "bg-warning/15 text-warning",
  drafts: "bg-accent/15 text-accent",
};

const CATEGORY_COLORS: Record<string, string> = {
  Updates: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400",
  Promotions: "bg-green-500/15 text-green-600 dark:text-green-400",
  Social: "bg-purple-500/15 text-purple-600 dark:text-purple-400",
  Newsletters: "bg-orange-500/15 text-orange-600 dark:text-orange-400",
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
      className={`relative w-full border-b border-border-secondary px-3 text-left transition-colors duration-150 ${
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
      <div className="flex items-start gap-2">
        {/* Avatar (sender photo → domain logo → initial); unread is a ring
            around it plus a dot below, so the avatar itself never changes.
            The column stretches to the row's height so the dot can sit in the
            space under the avatar rather than hanging off its edge. */}
        <div className="flex items-center self-start shrink-0 pt-0.5">
          {isMultiSelected ? (
              <div
                className={`rounded-full flex items-center justify-center font-medium text-text-secondary bg-bg-tertiary ${
                  emailDensity === "compact" ? "w-7 h-7 text-xs" : "w-7 h-7 text-xs"
                }`}
            >
              <Check size={emailDensity === "compact" ? 14 : 16} />
            </div>
          ) : (
            <SenderAvatar
              email={thread.fromAddress}
              name={thread.fromName}
              className="w-7 h-7 text-xs"
            />
          )}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          {/* First row: sender + date */}
          <div className="flex items-center justify-between gap-2">
            <span
              className={`text-[0.8125rem] truncate ${
                thread.isRead
                  ? "text-text-secondary"
                  : "font-semibold text-text-primary"
              }`}
            >
              {!thread.isRead && <span aria-hidden="true" className="inline-block w-1.5 h-1.5 mr-1.5 rounded-full bg-text-tertiary align-middle" />}
              <HighlightedText
                text={thread.fromName ?? thread.fromAddress ?? "Unknown"}
                terms={highlightTerms}
              />
            </span>
            <span className="flex items-center gap-1.5 shrink-0">
              {folder && (
                <span
                  data-testid="thread-folder"
                  className={`text-[0.625rem] px-1.5 rounded-full leading-normal whitespace-nowrap max-w-24 truncate ${
                    FOLDER_COLORS[folder.id] ?? "bg-bg-tertiary text-text-secondary"
                  }`}
                  title={`In ${folder.name}`}
                >
                  {folder.name}
                </span>
              )}
              <span className="text-xs text-text-tertiary whitespace-nowrap">
                {formatRelativeDate(thread.lastMessageAt)}
              </span>
            </span>
          </div>

          {/* Subject */}
          <div
            className={`text-[0.8125rem] truncate mt-0.5 ${
              thread.isRead ? "text-text-secondary" : "text-text-primary"
            }`}
          >
            <HighlightedText
              text={thread.subject ?? "(No subject)"}
              terms={highlightTerms}
            />
          </div>

          {/* Snippet + indicators */}
          <div className={`flex items-center gap-1.5 mt-0.5 ${emailDensity === "compact" ? "hidden" : ""}`}>
            <span className="text-[0.6875rem] text-text-tertiary truncate flex-1">
              {/* Who spoke last — a thread waiting on them reads differently
                  from one waiting on you */}
              {searchExcerpt == null && thread.lastFromMe && (
                <span
                  className="mr-1 px-1 py-px bg-bg-tertiary text-text-secondary font-medium align-baseline"
                  style={{ borderRadius: "5px" }}
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
              <span className={`shrink-0 text-[0.625rem] px-1.5 rounded-full leading-normal ${CATEGORY_COLORS[category]}`}>
                {category}
              </span>
            )}
            {hasFollowUp && (
              <span className="shrink-0 text-accent" title="Follow-up reminder set">
                <BellRing size={12} />
              </span>
            )}
            {hasTask && (
              <span className="shrink-0 text-accent" title="Has an open task">
                <CheckSquare size={12} />
              </span>
            )}
            {thread.isMuted && (
              <span className="shrink-0 text-warning" title="Muted">
                <VolumeX size={12} />
              </span>
            )}
            {thread.isPinned && (
              <span className="shrink-0 text-accent" title="Pinned">
                <Pin size={12} className="fill-current" />
              </span>
            )}
            {thread.hasAttachments && (
              <span className="shrink-0 text-text-tertiary" title="Has attachments">
                <Paperclip size={12} />
              </span>
            )}
            {thread.isStarred && (
              <span className="shrink-0 text-warning star-animate" title="Starred">
                <Star size={12} className="fill-current" />
              </span>
            )}
            {thread.messageCount > 1 && (
              <span className="text-xs text-text-tertiary shrink-0 bg-bg-tertiary rounded-full px-1.5">
                {thread.messageCount}
              </span>
            )}
          </div>
        </div>
      </div>

    </button>
  );
});
