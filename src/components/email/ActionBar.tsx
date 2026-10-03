import { useState, useEffect, useRef, useCallback } from "react";
import type { Thread } from "@/stores/threadStore";
import { useThreadStore } from "@/stores/threadStore";
import { useAccountStore } from "@/stores/accountStore";
import { useActiveLabel } from "@/hooks/useRouteNavigation";
import { archiveThread, trashThread, permanentDeleteThread, markThreadRead, starThread, spamThread } from "@/services/emailActions";
import { confirmDelete } from "@/utils/confirmDelete";
import { deleteThread as deleteThreadFromDb, pinThread as pinThreadDb, unpinThread as unpinThreadDb, muteThread as muteThreadDb, unmuteThread as unmuteThreadDb } from "@/services/db/threads";
import { deleteDraftsForThread } from "@/services/gmail/draftDeletion";
import { snoozeThread } from "@/services/snooze/snoozeManager";
import { getGmailClient } from "@/services/gmail/tokenManager";
import { SnoozeDialog } from "./SnoozeDialog";
import { FollowUpDialog } from "./FollowUpDialog";
import { Archive, Trash2, MailOpen, Mail, Star, Clock, Ban, Pin, MailMinus, BellRing, VolumeX, Reply, ReplyAll, Forward, FolderInput, Printer, Download, ExternalLink, PanelRightClose, PanelRightOpen, ListTodo, MessagesSquare, MoreHorizontal } from "lucide-react";
import type { DbMessage } from "@/services/db/messages";
import type { ThreadViewMode } from "@/stores/uiStore";
import { insertFollowUpReminder, getFollowUpForThread, cancelFollowUpForThread } from "@/services/db/followUpReminders";
import { Button } from "@/components/ui/Button";
import { useClickOutside } from "@/hooks/useClickOutside";

import { Tooltip } from "@/components/ui/Tooltip";
interface ActionBarProps {
  thread: Thread;
  messages?: DbMessage[];
  noReply?: boolean;
  defaultReplyMode?: "reply" | "replyAll";
  contactSidebarVisible?: boolean;
  taskSidebarVisible?: boolean;
  onReply?: () => void;
  onReplyAll?: () => void;
  onForward?: () => void;
  onPrint?: () => void;
  onExport?: () => void;
  onPopOut?: () => void;
  onToggleContactSidebar?: () => void;
  onToggleTaskSidebar?: () => void;
  threadViewMode?: ThreadViewMode;
  onToggleThreadViewMode?: () => void;
}

function Separator() {
  return <div className="h-5 w-px bg-border-secondary mx-1 shrink-0" />;
}

function MoreActionItem({
  icon,
  label,
  onClick,
  active = false,
  disabled = false,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-45 ${active ? "text-text-primary" : "text-text-secondary hover:text-text-primary"}`}
    >
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

export function ActionBar({ thread, messages, noReply, defaultReplyMode = "reply", contactSidebarVisible, taskSidebarVisible, onReply, onReplyAll, onForward, onPrint, onExport, onPopOut, onToggleContactSidebar, onToggleTaskSidebar, threadViewMode, onToggleThreadViewMode }: ActionBarProps) {
  const updateThread = useThreadStore((s) => s.updateThread);
  const removeThread = useThreadStore((s) => s.removeThread);
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  // Every action here targets the open thread, which in a unified list can
  // belong to a different mailbox than the sidebar's
  const threadAccountId = thread.accountId || activeAccountId;
  const activeLabel = useActiveLabel();
  const [showSnooze, setShowSnooze] = useState(false);
  const [showFollowUp, setShowFollowUp] = useState(false);
  const [showMoreActions, setShowMoreActions] = useState(false);
  const moreActionsRef = useRef<HTMLDivElement | null>(null);
  const moreActionsButtonRef = useRef<HTMLButtonElement | null>(null);
  const moreActionsMenuRef = useRef<HTMLDivElement | null>(null);
  const closeMoreActions = useCallback(() => setShowMoreActions(false), []);
  useClickOutside(moreActionsRef, closeMoreActions);
  const [hasFollowUp, setHasFollowUp] = useState(false);
  const isSpam = thread.labelIds.includes("SPAM");
  const hasLastMessage = !!messages?.length;

  useEffect(() => {
    if (showMoreActions) {
      moreActionsMenuRef.current?.querySelector<HTMLButtonElement>("[role=menuitem]:not(:disabled)")?.focus();
    }
  }, [showMoreActions]);

  const runMoreAction = (action: () => void | Promise<void>) => () => {
    setShowMoreActions(false);
    void action();
  };

  // Check if thread has an active follow-up reminder
  useEffect(() => {
    if (!threadAccountId) return;
    getFollowUpForThread(threadAccountId, thread.id)
      .then((r) => setHasFollowUp(r !== null))
      .catch(() => setHasFollowUp(false));
  }, [threadAccountId, thread.id]);

  const handleToggleRead = async () => {
    if (!threadAccountId) return;
    await markThreadRead(threadAccountId, thread.id, [], !thread.isRead);
  };

  const handleToggleStar = async () => {
    if (!threadAccountId) return;
    await starThread(threadAccountId, thread.id, [], !thread.isStarred);
  };

  const handleArchive = async () => {
    if (!threadAccountId) return;
    await archiveThread(threadAccountId, thread.id, []);
  };

  const handleDelete = async () => {
    if (!threadAccountId) return;
    const isTrashView = activeLabel === "trash";
    const isDraftsView = activeLabel === "drafts";
    if (isTrashView && !(await confirmDelete(1, true))) return;
    if (isTrashView) {
      await permanentDeleteThread(threadAccountId, thread.id, []);
      await deleteThreadFromDb(threadAccountId, thread.id);
    } else if (isDraftsView) {
      removeThread(thread.id);
      try {
        const client = await getGmailClient(threadAccountId);
        await deleteDraftsForThread(client, threadAccountId, thread.id);
      } catch (err) {
        console.error("Failed to delete drafts:", err);
      }
    } else {
      await trashThread(threadAccountId, thread.id, []);
    }
  };

  const handleSnooze = async (until: number) => {
    if (!threadAccountId) return;
    setShowSnooze(false);
    try {
      await snoozeThread(threadAccountId, thread.id, until);
      removeThread(thread.id);
    } catch (err) {
      console.error("Failed to snooze:", err);
    }
  };

  const handleSpam = async () => {
    if (!threadAccountId) return;
    await spamThread(threadAccountId, thread.id, [], !isSpam);
  };

  // Find the first message with an unsubscribe header
  const unsubscribeMessage = messages?.find((m) => m.list_unsubscribe);
  const hasUnsubscribe = !!unsubscribeMessage?.list_unsubscribe;
  const [unsubscribeStatus, setUnsubscribeStatus] = useState<"idle" | "loading" | "done">("idle");

  const handleUnsubscribe = async () => {
    if (!unsubscribeMessage?.list_unsubscribe || !threadAccountId) return;
    setUnsubscribeStatus("loading");
    try {
      const { executeUnsubscribe } = await import("@/services/unsubscribe/unsubscribeManager");
      const result = await executeUnsubscribe(
        threadAccountId,
        thread.id,
        unsubscribeMessage.from_address ?? "unknown",
        unsubscribeMessage.from_name,
        unsubscribeMessage.list_unsubscribe,
        unsubscribeMessage.list_unsubscribe_post,
      );
      if (result.success) {
        setUnsubscribeStatus("done");
        // Auto-archive after successful unsubscribe
        await archiveThread(threadAccountId, thread.id, []);
      } else {
        setUnsubscribeStatus("idle");
      }
    } catch (err) {
      console.error("Failed to unsubscribe:", err);
      setUnsubscribeStatus("idle");
    }
  };

  const handleTogglePin = async () => {
    if (!threadAccountId) return;
    const newPinned = !thread.isPinned;
    updateThread(thread.id, { isPinned: newPinned });
    try {
      if (newPinned) {
        await pinThreadDb(threadAccountId, thread.id);
      } else {
        await unpinThreadDb(threadAccountId, thread.id);
      }
    } catch (err) {
      console.error("Failed to toggle pin:", err);
      updateThread(thread.id, { isPinned: !newPinned });
    }
  };

  const handleToggleMute = async () => {
    if (!threadAccountId) return;
    const newMuted = !thread.isMuted;
    if (newMuted) {
      // Mute: mark as muted and archive
      updateThread(thread.id, { isMuted: true });
      try {
        await muteThreadDb(threadAccountId, thread.id);
        await archiveThread(threadAccountId, thread.id, []);
      } catch (err) {
        console.error("Failed to mute:", err);
        await unmuteThreadDb(threadAccountId, thread.id);
        updateThread(thread.id, { isMuted: false });
      }
    } else {
      // Unmute
      updateThread(thread.id, { isMuted: false });
      try {
        await unmuteThreadDb(threadAccountId, thread.id);
      } catch (err) {
        console.error("Failed to unmute:", err);
        updateThread(thread.id, { isMuted: true });
      }
    }
  };

  const handleFollowUp = async (remindAt: number) => {
    if (!threadAccountId || !messages || messages.length === 0) return;
    setShowFollowUp(false);
    const lastMsg = messages[messages.length - 1]!;
    try {
      await insertFollowUpReminder(threadAccountId, thread.id, lastMsg.id, remindAt);
      // The same thing said twice used to live in two tables. The reminder
      // engine still fires the notification; the task is what the user sees,
      // alongside everything else they have to do.
      const { insertTask } = await import("@/services/db/tasks");
      await insertTask({
        accountId: threadAccountId,
        title: thread.subject ? `Follow up: ${thread.subject}` : "Follow up",
        dueDate: remindAt,
        threadId: thread.id,
        threadAccountId,
        kind: "reminder",
      });
      setHasFollowUp(true);
      window.dispatchEvent(new CustomEvent("sndmail-tasks-changed"));
    } catch (err) {
      console.error("Failed to set follow-up reminder:", err);
    }
  };

  const handleCancelFollowUp = async () => {
    if (!threadAccountId) return;
    try {
      await cancelFollowUpForThread(threadAccountId, thread.id);
      // Cancelling the reminder closes the task standing for it
      const { getReminderTaskForThread, deleteTask } = await import("@/services/db/tasks");
      const reminderTask = await getReminderTaskForThread(threadAccountId, thread.id);
      if (reminderTask) await deleteTask(reminderTask.id);
      setHasFollowUp(false);
      window.dispatchEvent(new CustomEvent("sndmail-tasks-changed"));
    } catch (err) {
      console.error("Failed to cancel follow-up:", err);
    }
  };

  return (
    <>
      <div className="action-rail flex items-center gap-1 bg-transparent">
        {/* One common reply action stays visible; other response options live in More. */}
        {hasLastMessage && (
          <>
            <Tooltip content={noReply ? "This sender does not accept replies" : defaultReplyMode === "replyAll" ? "Reply all (r)" : "Reply (r)"}><Button
              variant="secondary"
              iconOnly
              icon={defaultReplyMode === "replyAll" ? <ReplyAll size={15} /> : <Reply size={15} />}
              onClick={defaultReplyMode === "replyAll" ? onReplyAll : onReply}
              disabled={noReply}

              className="disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-text-secondary"
            /></Tooltip>
            <Separator />
          </>
        )}

        {/* Keep the most common thread actions in the toolbar. */}
        <Tooltip content="Archive (e)"><Button variant="secondary" iconOnly icon={<Archive size={15} />} onClick={handleArchive}  /></Tooltip>
        <Tooltip content="Delete (#)"><Button variant="secondary" iconOnly icon={<Trash2 size={15} />} onClick={handleDelete}  /></Tooltip>
        <Tooltip content={thread.isStarred ? "Unstar (s)" : "Star (s)"}><Button
          variant="secondary"
          iconOnly
          icon={<Star size={15} className={thread.isStarred ? "fill-current" : ""} />}
          onClick={handleToggleStar}

          className={thread.isStarred ? "text-text-secondary" : ""}
        /></Tooltip>
        <Separator />
        <div ref={moreActionsRef} className="relative ml-auto shrink-0">
          <Tooltip content="More actions"><button
            ref={moreActionsButtonRef}
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            onClick={() => setShowMoreActions((open) => !open)}

            aria-label="More actions"
            aria-haspopup="menu"
            aria-expanded={showMoreActions}
          >
            <MoreHorizontal size={17} />
          </button></Tooltip>
          {showMoreActions && (
            <div
              ref={moreActionsMenuRef}
              role="menu"
              aria-label="More email actions"
              className="absolute right-0 top-full z-30 mt-1 w-56 rounded-xl border border-border-primary bg-white p-1 shadow-lg dark:bg-slate-900"
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setShowMoreActions(false);
                  moreActionsButtonRef.current?.focus();
                  return;
                }
                const items = Array.from(moreActionsMenuRef.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)") ?? []);
                const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
                let nextIndex: number | null = null;
                if (event.key === "ArrowDown") nextIndex = (currentIndex + 1) % items.length;
                else if (event.key === "ArrowUp") nextIndex = (currentIndex - 1 + items.length) % items.length;
                else if (event.key === "Home") nextIndex = 0;
                else if (event.key === "End") nextIndex = items.length - 1;
                if (nextIndex !== null) {
                  event.preventDefault();
                  items[nextIndex]?.focus();
                }
              }}
            >
              <MoreActionItem icon={thread.isRead ? <Mail size={15} /> : <MailOpen size={15} />} label={thread.isRead ? "Mark unread" : "Mark read"} onClick={runMoreAction(handleToggleRead)} />
              {hasLastMessage && <MoreActionItem icon={defaultReplyMode === "replyAll" ? <Reply size={15} /> : <ReplyAll size={15} />} label={defaultReplyMode === "replyAll" ? "Reply (a)" : "Reply all (a)"} disabled={noReply} onClick={runMoreAction(defaultReplyMode === "replyAll" ? () => onReply?.() : () => onReplyAll?.())} />}
              {hasLastMessage && <MoreActionItem icon={<Forward size={15} />} label="Forward (f)" onClick={runMoreAction(() => onForward?.())} />}
              <MoreActionItem icon={<Clock size={15} />} label="Snooze (h)" onClick={runMoreAction(() => setShowSnooze(true))} />
              <MoreActionItem icon={<Ban size={15} />} label={isSpam ? "Not spam (!)" : "Report spam (!)"} onClick={runMoreAction(handleSpam)} />
              <MoreActionItem
                icon={<FolderInput size={15} />}
                label="Move to folder (v)"
                onClick={runMoreAction(() => {
                  if (threadAccountId) window.dispatchEvent(new CustomEvent("sndmail-move-to-folder", { detail: { threadIds: [thread.id] } }));
                })}
              />
              <div role="separator" className="my-1 border-t border-border-secondary" />
              <MoreActionItem icon={<Pin size={15} className={thread.isPinned ? "fill-current" : ""} />} label={thread.isPinned ? "Unpin (p)" : "Pin (p)"} active={thread.isPinned} onClick={runMoreAction(handleTogglePin)} />
              <MoreActionItem icon={<VolumeX size={15} className={thread.isMuted ? "fill-current" : ""} />} label={thread.isMuted ? "Unmute (m)" : "Mute (m)"} active={thread.isMuted} onClick={runMoreAction(handleToggleMute)} />
              <MoreActionItem icon={<BellRing size={15} className={hasFollowUp ? "fill-current" : ""} />} label={hasFollowUp ? "Cancel follow-up reminder" : "Remind me if no reply"} active={hasFollowUp} onClick={runMoreAction(hasFollowUp ? handleCancelFollowUp : () => setShowFollowUp(true))} />
              {hasUnsubscribe && <MoreActionItem icon={<MailMinus size={15} />} label={unsubscribeStatus === "loading" ? "Unsubscribing…" : unsubscribeStatus === "done" ? "Unsubscribed" : "Unsubscribe (u)"} active={unsubscribeStatus === "done"} onClick={runMoreAction(handleUnsubscribe)} />}
              <div role="separator" className="my-1 border-t border-border-secondary" />
              {onToggleThreadViewMode && <MoreActionItem icon={<MessagesSquare size={15} />} label={threadViewMode === "chat" ? "Classic message list" : "Chat view"} active={threadViewMode === "chat"} onClick={runMoreAction(onToggleThreadViewMode)} />}
              <MoreActionItem icon={<Printer size={15} />} label="Print" onClick={runMoreAction(() => onPrint?.())} />
              <MoreActionItem icon={<Download size={15} />} label="Export as .eml" onClick={runMoreAction(() => onExport?.())} />
              <MoreActionItem icon={<ExternalLink size={15} />} label="Open in new window" onClick={runMoreAction(() => onPopOut?.())} />
              <MoreActionItem icon={<ListTodo size={15} />} label={taskSidebarVisible ? "Hide task panel" : "Show task panel"} active={taskSidebarVisible} onClick={runMoreAction(() => onToggleTaskSidebar?.())} />
              <MoreActionItem icon={contactSidebarVisible ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />} label={contactSidebarVisible ? "Hide contact sidebar" : "Show contact sidebar"} active={contactSidebarVisible} onClick={runMoreAction(() => onToggleContactSidebar?.())} />
            </div>
          )}
        </div>
      </div>

      <SnoozeDialog
        isOpen={showSnooze}
        onSnooze={handleSnooze}
        onClose={() => setShowSnooze(false)}
      />
      <FollowUpDialog
        isOpen={showFollowUp}
        onSetReminder={handleFollowUp}
        onClose={() => setShowFollowUp(false)}
      />
    </>
  );
}
