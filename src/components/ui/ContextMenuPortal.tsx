import { useState, useEffect, useRef } from "react";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { menuSurface, menuRow, menuHover, menuFont } from "./menuStyles";
import { useContextMenuStore } from "@/stores/contextMenuStore";
import { useThreadStore } from "@/stores/threadStore";
import { useTaskStore } from "@/stores/taskStore";
import { useAccountStore } from "@/stores/accountStore";
import { getActiveLabel, navigateToLabel } from "@/router/navigate";
import { useComposerStore } from "@/stores/composerStore";
import { useLabelStore } from "@/stores/labelStore";
import { archiveThread, trashThread, permanentDeleteThread, markThreadRead, starThread, spamThread, addThreadLabel, removeThreadLabel, runBulkAction, type BulkTarget } from "@/services/emailActions";
import { deleteThread as deleteThreadFromDb, pinThread as pinThreadDb, unpinThread as unpinThreadDb, muteThread as muteThreadDb, unmuteThread as unmuteThreadDb } from "@/services/db/threads";
import { deleteDraftsForThread } from "@/services/gmail/draftDeletion";
import { getGmailClient } from "@/services/gmail/tokenManager";
import { getMessagesForThread } from "@/services/db/messages";
import { snoozeThread } from "@/services/snooze/snoozeManager";
import { getEnabledQuickStepsForAccount, type DbQuickStep } from "@/services/db/quickSteps";
import { executeQuickStep } from "@/services/quickSteps/executor";
import type { QuickStep, QuickStepAction } from "@/services/quickSteps/types";
import { SnoozeDialog } from "../email/SnoozeDialog";
import {
  Reply,
  ReplyAll,
  Forward,
  Archive,
  Trash2,
  Mail,
  MailOpen,
  Star,
  Clock,
  Pin,
  Ban,
  Tag,
  FolderInput,
  ExternalLink,
  Pencil,
  Copy,
  Layers,
  VolumeX,
  Zap,
  Code,
  RefreshCw,
  ListTodo,
  Sparkles,
} from "lucide-react";
import { triggerSync } from "@/services/gmail/syncManager";
import { useUIStore } from "@/stores/uiStore";
import { setThreadCategory, ALL_CATEGORIES } from "@/services/db/threadCategories";
import { formatDateTime } from "@/utils/date";
import { recipientHeadersFromMessages } from "@/utils/resolveFromAddress";
import { confirmDelete } from "@/utils/confirmDelete";
import { createMailLink } from "@/utils/mailLink";
import { notify, reportError } from "@/stores/toastStore";
import { getIncompleteTaskCount, getTasksForThread, insertTask } from "@/services/db/tasks";
import { extractTask } from "@/services/ai/taskExtraction";

function buildQuote(msg: { from_name: string | null; from_address: string | null; date: string | number; body_html: string | null; body_text: string | null }): string {
  const date = formatDateTime(msg.date);
  const from = msg.from_name
    ? `${msg.from_name} &lt;${msg.from_address}&gt;`
    : (msg.from_address ?? "Unknown");
  return `<br><br><div style="border-left:2px solid #ccc;padding-left:12px;margin-left:0;color:#666">On ${date}, ${from} wrote:<br>${msg.body_html ?? msg.body_text ?? ""}</div>`;
}

function buildForwardQuote(msg: { from_name: string | null; from_address: string | null; date: string | number; subject: string | null; to_addresses: string | null; body_html: string | null; body_text: string | null }): string {
  const date = formatDateTime(msg.date);
  return `<br><br>---------- Forwarded message ---------<br>From: ${msg.from_name ?? ""} &lt;${msg.from_address ?? ""}&gt;<br>Date: ${date}<br>Subject: ${msg.subject ?? ""}<br>To: ${msg.to_addresses ?? ""}<br><br>${msg.body_html ?? msg.body_text ?? ""}`;
}

export function ContextMenuPortal() {
  const menuType = useContextMenuStore((s) => s.menuType);
  const position = useContextMenuStore((s) => s.position);
  const data = useContextMenuStore((s) => s.data);
  const closeMenu = useContextMenuStore((s) => s.closeMenu);
  const [snoozeTarget, setSnoozeTarget] = useState<
    { threads: { id: string; accountId: string }[] } | null
  >(null);

  if (!menuType) {
    if (snoozeTarget) {
      return (
        <SnoozeDialog
          onSnooze={async (until) => {
            for (const target of snoozeTarget.threads) {
              await snoozeThread(target.accountId, target.id, until);
              useThreadStore.getState().removeThread(target.id);
            }
            setSnoozeTarget(null);
          }}
          onClose={() => setSnoozeTarget(null)}
        />
      );
    }
    return null;
  }

  return (
    <>
      {menuType === "sidebarLabel" && (
        <SidebarLabelMenu position={position} data={data} onClose={closeMenu} />
      )}
      {menuType === "sidebarNav" && (
        <SidebarNavMenu position={position} data={data} onClose={closeMenu} />
      )}
      {menuType === "sidebarSmartFolder" && (
        <SidebarSmartFolderMenu position={position} data={data} onClose={closeMenu} />
      )}
      {menuType === "thread" && (
        <ThreadMenu
          position={position}
          data={data}
          onClose={closeMenu}
          onSnooze={setSnoozeTarget}
        />
      )}
      {menuType === "message" && (
        <MessageMenu position={position} data={data} onClose={closeMenu} />
      )}
      {menuType === "textSelection" && (
        <TextSelectionMenu position={position} data={data} onClose={closeMenu} />
      )}
      {snoozeTarget && (
        <SnoozeDialog
          onSnooze={async (until) => {
            for (const target of snoozeTarget.threads) {
              await snoozeThread(target.accountId, target.id, until);
              useThreadStore.getState().removeThread(target.id);
            }
            setSnoozeTarget(null);
          }}
          onClose={() => setSnoozeTarget(null)}
        />
      )}
    </>
  );
}

function SidebarSmartFolderMenu({
  position,
  data,
  onClose,
}: {
  position: { x: number; y: number };
  data: Record<string, unknown>;
  onClose: () => void;
}) {
  const query = data["query"] as string | undefined;
  const onEdit = data["onEdit"] as (() => void) | undefined;
  const items: ContextMenuItem[] = [
    {
      id: "smart-folder-query",
      label: query ? `Search: ${query}` : "No search query",
      icon: Code,
      disabled: true,
    },
    { id: "sep-smart-folder", label: "", separator: true },
    {
      id: "edit-smart-folder",
      label: "Edit smart folder setup",
      icon: Pencil,
      action: () => onEdit?.(),
    },
  ];
  return <ContextMenu items={items} position={position} onClose={onClose} />;
}

function SidebarLabelMenu({
  position,
  data,
  onClose,
}: {
  position: { x: number; y: number };
  data: Record<string, unknown>;
  onClose: () => void;
}) {
  const onEdit = data["onEdit"] as (() => void) | undefined;
  const onDelete = data["onDelete"] as (() => void) | undefined;
  const activeAccountId = useAccountStore((s) => s.activeAccountId);

  const handleSync = () => {
    if (!activeAccountId) return;
    const labelId = data["labelId"] as string | undefined;
    useUIStore.getState().setSyncingFolder(labelId ?? "label");
    triggerSync([activeAccountId]);
  };

  const items: ContextMenuItem[] = [
    {
      id: "sync-folder",
      label: "Sync this folder",
      icon: RefreshCw,
      action: handleSync,
    },
    { id: "sep-sync", label: "", separator: true },
    {
      id: "edit-label",
      label: "Edit label",
      icon: Pencil,
      action: () => onEdit?.(),
    },
    {
      id: "delete-label",
      label: "Delete label",
      icon: Trash2,
      danger: true,
      action: () => onDelete?.(),
    },
  ];

  return <ContextMenu items={items} position={position} onClose={onClose} />;
}

function SidebarNavMenu({
  position,
  data,
  onClose,
}: {
  position: { x: number; y: number };
  data: Record<string, unknown>;
  onClose: () => void;
}) {
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const navId = data["navId"] as string;

  const handleSync = () => {
    if (!activeAccountId) return;
    useUIStore.getState().setSyncingFolder(navId);
    triggerSync([activeAccountId]);
  };

  const items: ContextMenuItem[] = [
    {
      id: "sync-folder",
      label: "Sync this folder",
      icon: RefreshCw,
      action: handleSync,
    },
  ];

  return <ContextMenu items={items} position={position} onClose={onClose} />;
}

function ThreadMenu({
  position,
  data,
  onClose,
  onSnooze,
}: {
  position: { x: number; y: number };
  data: Record<string, unknown>;
  onClose: () => void;
  onSnooze: (target: { threads: { id: string; accountId: string }[] }) => void;
}) {
  const threadId = data["threadId"] as string;
  const threads = useThreadStore((s) => s.threads);
  const selectedThreadIds = useThreadStore((s) => s.selectedThreadIds);
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const activeLabel = getActiveLabel();
  const labels = useLabelStore((s) => s.labels);
  const openComposer = useComposerStore((s) => s.openComposer);
  const [quickSteps, setQuickSteps] = useState<DbQuickStep[]>([]);

  useEffect(() => {
    if (!activeAccountId) return;
    getEnabledQuickStepsForAccount(activeAccountId).then(setQuickSteps).catch(() => {
      // quick_steps table may not exist yet before migration
    });
  }, [activeAccountId]);

  // Determine target threads: if right-clicked thread is in multi-select, use all selected; otherwise just this one
  const isInMultiSelect = selectedThreadIds.has(threadId);
  const targetIds = isInMultiSelect && selectedThreadIds.size > 1
    ? [...selectedThreadIds]
    : [threadId];
  const isMulti = targetIds.length > 1;

  const thread = threads.find((t) => t.id === threadId);
  if (!thread || !activeAccountId) {
    return <ContextMenu items={[]} position={position} onClose={onClose} />;
  }

  // A unified list spans mailboxes — act on each thread's own account, not
  // whichever mailbox the sidebar happens to have selected. A multi-selection
  // can span accounts too.
  const threadAccountId = thread.accountId || activeAccountId;
  const accountFor = (id: string): string =>
    threads.find((t) => t.id === id)?.accountId || activeAccountId;

  const isTrashView = activeLabel === "trash";
  const isDraftsView = activeLabel === "drafts";
  const isSpamView = activeLabel === "spam";

  // For single thread: show current state. For multi: be generic
  const isRead = isMulti ? true : thread.isRead;
  const isStarred = isMulti ? false : thread.isStarred;
  const isPinned = isMulti ? false : thread.isPinned;
  const isMuted = isMulti ? false : thread.isMuted;

  const handleReply = async () => {
    const messages = await getMessagesForThread(threadAccountId, thread.id);
    const lastMessage = messages[messages.length - 1];
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
  };

  const handleReplyAll = async () => {
    const messages = await getMessagesForThread(threadAccountId, thread.id);
    const lastMessage = messages[messages.length - 1];
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
  };

  const handleForward = async () => {
    const messages = await getMessagesForThread(threadAccountId, thread.id);
    const lastMessage = messages[messages.length - 1];
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
  };

  const targets = (): BulkTarget[] =>
    targetIds.map((threadId) => ({ accountId: accountFor(threadId), threadId }));

  const handleArchive = async () => {
    await runBulkAction(
      targets(),
      ({ accountId, threadId }) => archiveThread(accountId, threadId, []),
      { removes: true },
    );
  };

  const handleDelete = async () => {
    if (!(await confirmDelete(targetIds.length, isTrashView))) return;
    await runBulkAction(
      targets(),
      async ({ accountId, threadId }) => {
        if (isTrashView) {
          await permanentDeleteThread(accountId, threadId, []);
          await deleteThreadFromDb(accountId, threadId);
        } else if (isDraftsView) {
          const client = await getGmailClient(accountId);
          await deleteDraftsForThread(client, accountId, threadId);
        } else {
          await trashThread(accountId, threadId, []);
        }
      },
      { removes: true },
    );
  };

  const handleToggleRead = async () => {
    for (const id of targetIds) {
      const t = threads.find((th) => th.id === id);
      if (!t) continue;
      await markThreadRead(accountFor(id), id, [], !t.isRead);
    }
  };

  const handleToggleStar = async () => {
    for (const id of targetIds) {
      const t = threads.find((th) => th.id === id);
      if (!t) continue;
      await starThread(accountFor(id), id, [], !t.isStarred);
    }
  };

  const handleTogglePin = async () => {
    for (const id of targetIds) {
      const t = threads.find((th) => th.id === id);
      if (!t) continue;
      const newPinned = !t.isPinned;
      useThreadStore.getState().updateThread(id, { isPinned: newPinned });
      if (newPinned) {
        await pinThreadDb(accountFor(id), id);
      } else {
        await unpinThreadDb(accountFor(id), id);
      }
    }
  };

  const handleSpam = async () => {
    for (const id of targetIds) {
      await spamThread(accountFor(id), id, [], !isSpamView);
    }
  };

  const handleSnooze = () => {
    onSnooze({
      threads: targetIds.map((id) => ({ id, accountId: accountFor(id) })),
    });
  };

  const handleToggleMute = async () => {
    for (const id of targetIds) {
      const t = threads.find((th) => th.id === id);
      if (!t) continue;
      const newMuted = !t.isMuted;
      if (newMuted) {
        await muteThreadDb(accountFor(id), id);
        await archiveThread(accountFor(id), id, []);
      } else {
        await unmuteThreadDb(accountFor(id), id);
        useThreadStore.getState().updateThread(id, { isMuted: false });
      }
    }
  };

  const handlePopOut = async () => {
    try {
      const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      const windowLabel = `thread-${thread.id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
      const url = `index.html?thread=${encodeURIComponent(thread.id)}&account=${encodeURIComponent(thread.accountId)}`;
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
  };

  const handleToggleLabel = async (labelId: string) => {
    for (const id of targetIds) {
      const t = useThreadStore.getState().threads.find((th) => th.id === id);
      if (!t) continue;
      const hasLabel = t.labelIds.includes(labelId);
      if (hasLabel) {
        await removeThreadLabel(accountFor(id), id, labelId);
        useThreadStore.getState().updateThread(id, {
          labelIds: t.labelIds.filter((l) => l !== labelId),
        });
      } else {
        await addThreadLabel(accountFor(id), id, labelId);
        useThreadStore.getState().updateThread(id, {
          labelIds: [...t.labelIds, labelId],
        });
      }
    }
  };

  // Build label submenu items
  const labelItems: ContextMenuItem[] = labels.map((label) => {
    // For single thread, show checkmark if label is applied
    const isApplied = !isMulti && thread.labelIds.includes(label.id);
    return {
      id: `label-${label.id}`,
      label: label.name,
      checked: isApplied,
      action: () => handleToggleLabel(label.id),
    };
  });

  const items: ContextMenuItem[] = [
    {
      id: "reply",
      label: "Reply",
      icon: Reply,
      shortcutId: "action.reply",
      disabled: isMulti,
      action: handleReply,
    },
    {
      id: "reply-all",
      label: "Reply All",
      icon: ReplyAll,
      shortcutId: "action.replyAll",
      disabled: isMulti,
      action: handleReplyAll,
    },
    {
      id: "forward",
      label: "Forward",
      icon: Forward,
      shortcutId: "action.forward",
      disabled: isMulti,
      action: handleForward,
    },
    { id: "sep-1", label: "", separator: true },
    {
      id: "archive",
      label: "Archive",
      icon: Archive,
      shortcutId: "action.archive",
      action: handleArchive,
    },
    {
      id: "delete",
      label: isTrashView ? "Delete Permanently" : "Delete",
      icon: Trash2,
      shortcutId: "action.delete",
      danger: isTrashView,
      action: handleDelete,
    },
    {
      id: "toggle-read",
      label: isRead ? "Mark as Unread" : "Mark as Read",
      icon: isRead ? Mail : MailOpen,
      action: handleToggleRead,
    },
    {
      id: "toggle-star",
      label: isStarred ? "Unstar" : "Star",
      icon: Star,
      shortcutId: "action.star",
      action: handleToggleStar,
    },
    { id: "sep-2", label: "", separator: true },
    {
      id: "snooze",
      label: "Snooze...",
      icon: Clock,
      action: handleSnooze,
    },
    {
      id: "toggle-pin",
      label: isPinned ? "Unpin" : "Pin",
      icon: Pin,
      shortcutId: "action.pin",
      action: handleTogglePin,
    },
    {
      id: "toggle-mute",
      label: isMuted ? "Unmute" : "Mute",
      icon: VolumeX,
      shortcutId: "action.mute",
      action: handleToggleMute,
    },
    {
      id: "spam",
      label: isSpamView ? "Not Spam" : "Report Spam",
      icon: Ban,
      shortcutId: "action.spam",
      action: handleSpam,
    },
    { id: "sep-3", label: "", separator: true },
    ...(labelItems.length > 0
      ? [{
          id: "apply-label",
          label: "Apply Label",
          icon: Tag,
          children: labelItems,
        }]
      : []),
    {
      id: "move-to-folder",
      label: "Move to Folder",
      icon: FolderInput,
      shortcutId: "action.moveToFolder",
      action: () => {
        window.dispatchEvent(new CustomEvent("sndmail-move-to-folder", { detail: { threadIds: [...targetIds] } }));
      },
    },
    {
      id: "move-to-category",
      label: "Move to Category",
      icon: Layers,
      children: ALL_CATEGORIES.map((cat) => ({
        id: `cat-${cat}`,
        label: cat,
        action: async () => {
          for (const id of targetIds) {
            await setThreadCategory(accountFor(id), id, cat, true);
          }
          window.dispatchEvent(new Event("sndmail-sync-done"));
        },
      })),
    },
    ...(quickSteps.length > 0
      ? [
          { id: "sep-4", label: "", separator: true },
          {
            id: "quick-steps",
            label: "Quick Steps",
            icon: Zap,
            children: quickSteps.map((qs) => {
              let parsedActions: QuickStepAction[] = [];
              try {
                parsedActions = JSON.parse(qs.actions_json) as QuickStepAction[];
              } catch { /* ignore */ }
              return {
                id: `qs-${qs.id}`,
                label: qs.name,
                action: async () => {
                  const step: QuickStep = {
                    id: qs.id,
                    accountId: qs.account_id,
                    name: qs.name,
                    description: qs.description,
                    shortcut: qs.shortcut,
                    actions: parsedActions,
                    icon: qs.icon,
                    isEnabled: qs.is_enabled === 1,
                    continueOnError: qs.continue_on_error === 1,
                    sortOrder: qs.sort_order,
                    createdAt: qs.created_at,
                  };
                  // A selection can span mailboxes — run the step once per account
                  const byAccount = new Map<string, string[]>();
                  for (const id of targetIds) {
                    const acc = accountFor(id);
                    byAccount.set(acc, [...(byAccount.get(acc) ?? []), id]);
                  }
                  for (const [acc, ids] of byAccount) {
                    await executeQuickStep(step, ids, acc);
                  }
                },
              };
            }),
          } as ContextMenuItem,
        ]
      : []),
    {
      id: "pop-out",
      label: "Open in New Window",
      icon: ExternalLink,
      disabled: isMulti,
      action: handlePopOut,
    },
  ];

  return <ContextMenu items={items} position={position} onClose={onClose} />;
}

function MessageMenu({
  position,
  data,
  onClose,
}: {
  position: { x: number; y: number };
  data: Record<string, unknown>;
  onClose: () => void;
}) {
  const openComposer = useComposerStore((s) => s.openComposer);

  const messageId = data["messageId"] as string;
  const threadId = data["threadId"] as string;
  const accountId = data["accountId"] as string | null;
  const fromAddress = data["fromAddress"] as string | null;
  const fromName = data["fromName"] as string | null;
  const replyTo = data["replyTo"] as string | null;
  const toAddresses = data["toAddresses"] as string | null;
  const ccAddresses = data["ccAddresses"] as string | null;
  const subject = data["subject"] as string | null;
  const date = data["date"] as string | number;
  const bodyHtml = data["bodyHtml"] as string | null;
  const bodyText = data["bodyText"] as string | null;

  const msg = { from_name: fromName, from_address: fromAddress, date, body_html: bodyHtml, body_text: bodyText, subject, to_addresses: toAddresses };

  const handleReply = () => {
    const replyAddr = replyTo ?? fromAddress;
    openComposer({
      mode: "reply",
      to: replyAddr ? [replyAddr] : [],
      subject: `Re: ${subject ?? ""}`,
      bodyHtml: buildQuote(msg),
      threadId,
      inReplyToMessageId: messageId,
      originalRecipients: [toAddresses, ccAddresses].filter((h): h is string => !!h),
      accountId,
    });
  };

  const handleReplyAll = () => {
    const replyAddr = replyTo ?? fromAddress;
    const allRecipients = new Set<string>();
    if (replyAddr) allRecipients.add(replyAddr);
    if (toAddresses) {
      toAddresses.split(",").forEach((a) => allRecipients.add(a.trim()));
    }
    const ccList: string[] = [];
    if (ccAddresses) {
      ccAddresses.split(",").forEach((a) => ccList.push(a.trim()));
    }
    openComposer({
      mode: "replyAll",
      to: Array.from(allRecipients),
      cc: ccList,
      subject: `Re: ${subject ?? ""}`,
      bodyHtml: buildQuote(msg),
      threadId,
      inReplyToMessageId: messageId,
      originalRecipients: [toAddresses, ccAddresses].filter((h): h is string => !!h),
      accountId,
    });
  };

  const handleForward = () => {
    openComposer({
      mode: "forward",
      to: [],
      subject: `Fwd: ${subject ?? ""}`,
      bodyHtml: buildForwardQuote(msg),
      threadId,
      inReplyToMessageId: messageId,
      originalRecipients: [toAddresses, ccAddresses].filter((h): h is string => !!h),
      accountId,
    });
  };

  const handleCopy = async () => {
    const text = bodyText ?? "";
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback: no-op in non-secure contexts
    }
  };

  const items: ContextMenuItem[] = [
    {
      id: "reply",
      label: "Reply",
      icon: Reply,
      shortcutId: "action.reply",
      action: handleReply,
    },
    {
      id: "reply-all",
      label: "Reply All",
      icon: ReplyAll,
      shortcutId: "action.replyAll",
      action: handleReplyAll,
    },
    {
      id: "forward",
      label: "Forward",
      icon: Forward,
      shortcutId: "action.forward",
      action: handleForward,
    },
    { id: "sep-1", label: "", separator: true },
    {
      id: "copy-text",
      label: "Copy Message Text",
      icon: Copy,
      action: handleCopy,
    },
    ...(accountId
      ? [
          {
            id: "copy-message-link",
            label: "Copy Message Link",
            icon: ExternalLink,
            action: async () => {
              try {
                const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
                await writeText(createMailLink({ accountId, threadId, messageId }));
                notify("success", "Message link copied");
              } catch (error) { reportError("Could not copy message link", error); }
            },
          },
          {
            id: "copy-message-ids",
            label: "Copy Message IDs",
            icon: Copy,
            action: async () => {
              try {
                const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
                await writeText(JSON.stringify({ accountId, threadId, messageId }, null, 2));
                notify("success", "Message IDs copied");
              } catch (error) { reportError("Could not copy message IDs", error); }
            },
          },
          { id: "sep-2", label: "", separator: true },
          {
            id: "view-source",
            label: "View Source",
            icon: Code,
            action: () => {
              window.dispatchEvent(
                new CustomEvent("sndmail-view-raw-message", {
                  detail: { messageId, accountId },
                }),
              );
            },
          },
        ]
      : []),
  ];

  return <ContextMenu items={items} position={position} onClose={onClose} />;
}

function TextSelectionMenu({
  position,
  data,
  onClose,
}: {
  position: { x: number; y: number };
  data: Record<string, unknown>;
  onClose: () => void;
}) {
  const accountId = data["accountId"] as string | null;
  const threadId = data["threadId"] as string | null;
  const text = (data["text"] as string | undefined)?.trim() ?? "";
  const canMakeTask = !!accountId && !!threadId && !!text;
  const isContextMenu = data["contextMenu"] === true;
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [creating, setCreating] = useState<"task" | "ai" | null>(null);

  useEffect(() => {
    if (isContextMenu) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!popoverRef.current?.contains(event.target as Node)) onClose();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [onClose, isContextMenu]);

  useEffect(() => {
    const popover = popoverRef.current;
    if (!popover) return;
    const rect = popover.getBoundingClientRect();
    const left = Math.min(Math.max(4, position.x), window.innerWidth - rect.width - 4);
    const top = Math.min(Math.max(4, position.y + 8), window.innerHeight - rect.height - 4);
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
  }, [position]);

  const createLinkedTask = async (task: {
    title: string;
    description?: string | null;
    priority?: import("@/services/db/tasks").TaskPriority;
    dueDate?: number | null;
  }) => {
    if (!accountId || !threadId) return;
    const taskId = await insertTask({
      accountId,
      threadId,
      threadAccountId: accountId,
      ...task,
    });
    const [count, threadTasks] = await Promise.all([
      getIncompleteTaskCount(accountId),
      getTasksForThread(accountId, threadId),
    ]);
    useTaskStore.getState().setIncompleteCount(count);
    useTaskStore.getState().setThreadTasks(threadTasks);
    useTaskStore.getState().setSelectedTaskId(taskId);
    window.dispatchEvent(new Event("snd-tasks-changed"));
    navigateToLabel("tasks");
    return taskId;
  };

  const makeTask = async () => {
    if (!canMakeTask || creating) return;
    setCreating("task");
    try {
      await createLinkedTask({ title: text });
      notify("success", "Task created", text);
      onClose();
    } catch (error) {
      reportError("Could not create task", error);
      setCreating(null);
    }
  };

  const makeAiTask = async () => {
    if (!canMakeTask || creating || !accountId || !threadId) return;
    setCreating("ai");
    try {
      const messages = await getMessagesForThread(accountId, threadId);
      const extracted = await extractTask(threadId, accountId, messages, text);
      await createLinkedTask({
        title: extracted.title,
        // Preserve the exact selection alongside the AI's concise summary.
        description: extracted.description
          ? `${extracted.description}\n\nSelected text: ${text}`
          : text,
        priority: extracted.priority,
        dueDate: extracted.dueDate,
      });
      notify("success", "AI task created", extracted.title);
      onClose();
    } catch (error) {
      reportError("Could not create AI task", error);
      setCreating(null);
    }
  };

  if (isContextMenu) {
    return <ContextMenu position={position} onClose={onClose} items={[
      { id: "copy-selection", label: "Copy", icon: Copy, action: () => {
        void import("@tauri-apps/plugin-clipboard-manager")
          .then(({ writeText }) => writeText(text))
          .catch((error) => reportError("Could not copy", error));
      } },
      { id: "selection-divider", label: "", separator: true },
      { id: "make-task", label: "Make task", icon: ListTodo, disabled: !canMakeTask || !!creating, action: () => { void makeTask(); } },
      { id: "make-ai-task", label: "Make AI task", icon: Sparkles, disabled: !canMakeTask || !!creating, action: () => { void makeAiTask(); } },
    ]} />;
  }

  return (
    <div
      ref={popoverRef}
      role="group"
      aria-label="Create task from selected text"
      className={`${menuSurface} flex items-center`}
      style={{ ...menuFont, left: position.x, top: position.y + 8 }}
      onMouseDown={(event) => event.preventDefault()}
    >
      <button
        type="button"
        disabled={!canMakeTask || !!creating}
        onClick={() => void makeTask()}
        className={`${menuRow} ${menuHover} whitespace-nowrap`}
      >
        <ListTodo size={13} />
        {creating === "task" ? "Creating..." : "Make task"}
      </button>
      <span className="h-4 w-px bg-border-secondary" aria-hidden="true" />
      <button
        type="button"
        disabled={!canMakeTask || !!creating}
        onClick={() => void makeAiTask()}
        className={`${menuRow} ${menuHover} whitespace-nowrap text-accent`}
      >
        <Sparkles size={13} />
        {creating === "ai" ? "Building..." : "Make AI task"}
      </button>
    </div>
  );
}
