import { useUIStore } from "@/stores/uiStore";
import { useThreadStore } from "@/stores/threadStore";
import { getEmailProvider } from "@/services/email/providerFactory";
import { enqueuePendingOperation } from "@/services/db/pendingOperations";
import { classifyError } from "@/utils/networkErrors";
import { getDb } from "@/services/db/connection";
import { upsertMessage } from "@/services/db/messages";
import { upsertThread, setThreadLabels, getThreadLabelIds } from "@/services/db/threads";
import { navigateToThread, getActiveLabel, getSelectedThreadId } from "@/router/navigate";

// ---------------------------------------------------------------------------
// Action types
// ---------------------------------------------------------------------------

export type EmailAction =
  | { type: "archive"; threadId: string; messageIds: string[] }
  | { type: "trash"; threadId: string; messageIds: string[] }
  | { type: "permanentDelete"; threadId: string; messageIds: string[] }
  | {
      type: "markRead";
      threadId: string;
      messageIds: string[];
      read: boolean;
    }
  | {
      type: "star";
      threadId: string;
      messageIds: string[];
      starred: boolean;
    }
  | {
      type: "spam";
      threadId: string;
      messageIds: string[];
      isSpam: boolean;
    }
  | {
      type: "moveToFolder";
      threadId: string;
      messageIds: string[];
      folderPath: string;
    }
  | { type: "addLabel"; threadId: string; labelId: string }
  | { type: "removeLabel"; threadId: string; labelId: string }
  | {
      type: "sendMessage";
      rawBase64Url: string;
      threadId?: string;
    }
  | {
      type: "createDraft";
      rawBase64Url: string;
      threadId?: string;
    }
  | {
      type: "updateDraft";
      draftId: string;
      rawBase64Url: string;
      threadId?: string;
    }
  | { type: "deleteDraft"; draftId: string };

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface ActionResult {
  success: boolean;
  queued?: boolean;
  error?: string;
  data?: unknown;
}

// ---------------------------------------------------------------------------
// Optimistic UI helpers
// ---------------------------------------------------------------------------

function getNextThreadId(currentId: string): string | null {
  // Only auto-advance if the removed thread is the one being viewed
  const selectedId = getSelectedThreadId();
  if (selectedId !== currentId) return null;
  const { threads } = useThreadStore.getState();
  const idx = threads.findIndex((t) => t.id === currentId);
  if (idx === -1) return null;
  // Prefer next thread, fall back to previous
  const next = threads[idx + 1];
  if (next) return next.id;
  const prev = threads[idx - 1];
  if (prev) return prev.id;
  return null;
}

function applyOptimisticUpdate(action: EmailAction): void {
  const store = useThreadStore.getState();
  switch (action.type) {
    case "archive":
    case "trash":
    case "permanentDelete":
    case "moveToFolder": {
      const nextId = getNextThreadId(action.threadId);
      // Fades the row out, then drops it — the list still updates immediately
      store.beginThreadRemoval(action.threadId);
      if (nextId) {
        navigateToThread(nextId);
      }
      break;
    }
    case "spam": {
      // Reporting spam always leaves the current list. Restoring it only
      // leaves the Spam folder; from search or an already-stale Inbox view it
      // should remain visible and simply lose its spam state.
      if (action.isSpam || getActiveLabel() === "spam") {
        const nextId = getNextThreadId(action.threadId);
        store.beginThreadRemoval(action.threadId);
        if (nextId) navigateToThread(nextId);
      } else {
        const current = store.threadMap.get(action.threadId);
        if (current) {
          store.updateThread(action.threadId, {
            labelIds: [
              ...new Set([
                ...current.labelIds.filter((labelId) => labelId !== "SPAM"),
                "INBOX",
              ]),
            ],
          });
        }
      }
      break;
    }
    case "markRead":
      store.updateThread(action.threadId, { isRead: action.read });
      break;
    case "star":
      store.updateThread(action.threadId, { isStarred: action.starred });
      break;
    case "addLabel":
    case "removeLabel":
    case "sendMessage":
    case "createDraft":
    case "updateDraft":
    case "deleteDraft":
      // No universal optimistic update for these
      break;
  }
}

function revertOptimisticUpdate(action: EmailAction): void {
  const store = useThreadStore.getState();
  switch (action.type) {
    case "markRead":
      store.updateThread(action.threadId, { isRead: !action.read });
      break;
    case "star":
      store.updateThread(action.threadId, { isStarred: !action.starred });
      break;
    // For removes (archive/trash/spam/move), we can't easily restore the thread
    // to the list from here. The next sync will fix it.
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Local DB updates (so offline reads reflect changes)
// ---------------------------------------------------------------------------

async function applyLocalDbUpdate(
  accountId: string,
  action: EmailAction,
): Promise<void> {
  const db = await getDb();
  switch (action.type) {
    case "markRead":
      await db.execute(
        "UPDATE threads SET is_read = $1 WHERE account_id = $2 AND id = $3",
        [action.read ? 1 : 0, accountId, action.threadId],
      );
      break;
    case "star":
      await db.execute(
        "UPDATE threads SET is_starred = $1 WHERE account_id = $2 AND id = $3",
        [action.starred ? 1 : 0, accountId, action.threadId],
      );
      if (action.starred) {
        await db.execute(
          "INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id) VALUES ($1, $2, 'STARRED')",
          [accountId, action.threadId],
        );
      } else {
        await db.execute(
          "DELETE FROM thread_labels WHERE account_id = $1 AND thread_id = $2 AND label_id = 'STARRED'",
          [accountId, action.threadId],
        );
      }
      break;
    case "archive":
      await db.execute(
        "DELETE FROM thread_labels WHERE account_id = $1 AND thread_id = $2 AND label_id = 'INBOX'",
        [accountId, action.threadId],
      );
      break;
    case "trash":
      await db.execute(
        "DELETE FROM thread_labels WHERE account_id = $1 AND thread_id = $2 AND label_id = 'INBOX'",
        [accountId, action.threadId],
      );
      await db.execute(
        "INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id) VALUES ($1, $2, 'TRASH')",
        [accountId, action.threadId],
      );
      break;
    case "permanentDelete":
      await db.execute(
        "DELETE FROM threads WHERE account_id = $1 AND id = $2",
        [accountId, action.threadId],
      );
      break;
    case "spam":
      if (action.isSpam) {
        await db.execute(
          "DELETE FROM thread_labels WHERE account_id = $1 AND thread_id = $2 AND label_id = 'INBOX'",
          [accountId, action.threadId],
        );
        await db.execute(
          "INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id) VALUES ($1, $2, 'SPAM')",
          [accountId, action.threadId],
        );
      } else {
        await db.execute(
          "DELETE FROM thread_labels WHERE account_id = $1 AND thread_id = $2 AND label_id = 'SPAM'",
          [accountId, action.threadId],
        );
        await db.execute(
          "INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id) VALUES ($1, $2, 'INBOX')",
          [accountId, action.threadId],
        );
      }
      break;
    case "addLabel":
      await db.execute(
        "INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id) VALUES ($1, $2, $3)",
        [accountId, action.threadId, action.labelId],
      );
      break;
    case "removeLabel":
      await db.execute(
        "DELETE FROM thread_labels WHERE account_id = $1 AND thread_id = $2 AND label_id = $3",
        [accountId, action.threadId, action.labelId],
      );
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Core execution
// ---------------------------------------------------------------------------

function getResourceId(action: EmailAction): string {
  if ("threadId" in action && action.threadId) return action.threadId;
  if ("draftId" in action) return action.draftId;
  return crypto.randomUUID();
}

function actionToParams(action: EmailAction): Record<string, unknown> {
  // Strip the type field — it's stored separately as operation_type
  const { type: _, ...rest } = action;
  return rest;
}

async function executeViaProvider(
  accountId: string,
  action: EmailAction,
): Promise<unknown> {
  const provider = await getEmailProvider(accountId);
  switch (action.type) {
    case "archive":
      return provider.archive(action.threadId, action.messageIds);
    case "trash":
      return provider.trash(action.threadId, action.messageIds);
    case "permanentDelete":
      return provider.permanentDelete(action.threadId, action.messageIds);
    case "markRead":
      return provider.markRead(
        action.threadId,
        action.messageIds,
        action.read,
      );
    case "star":
      return provider.star(
        action.threadId,
        action.messageIds,
        action.starred,
      );
    case "spam":
      return provider.spam(
        action.threadId,
        action.messageIds,
        action.isSpam,
      );
    case "moveToFolder":
      return provider.moveToFolder(
        action.threadId,
        action.messageIds,
        action.folderPath,
      );
    case "addLabel":
      return provider.addLabel(action.threadId, action.labelId);
    case "removeLabel":
      return provider.removeLabel(action.threadId, action.labelId);
    case "sendMessage":
      return provider.sendMessage(action.rawBase64Url, action.threadId);
    case "createDraft":
      return provider.createDraft(action.rawBase64Url, action.threadId);
    case "updateDraft":
      return provider.updateDraft(
        action.draftId,
        action.rawBase64Url,
        action.threadId,
      );
    case "deleteDraft":
      return provider.deleteDraft(action.draftId);
  }
}

/**
 * Fill in `messageIds` when the caller passed none.
 *
 * Every caller passes `[]` — a thread action is expressed per thread — and
 * the Gmail provider ignores the list, so nothing noticed that the IMAP
 * provider does its work *per message*: it groups the ids by folder and moves
 * those UIDs, and with no ids it moved nothing. The thread left the list, the
 * local DB agreed, and the mail sat untouched on the server. Resolved here,
 * before the queue sees the action, so an operation replayed later carries the
 * ids even after the thread's rows are gone.
 */
async function withMessageIds(
  accountId: string,
  action: EmailAction,
): Promise<EmailAction> {
  if (!("messageIds" in action) || action.messageIds.length > 0) return action;
  try {
    const db = await getDb();
    const rows = await db.select<{ id: string }[]>(
      "SELECT id FROM messages WHERE account_id = $1 AND thread_id = $2",
      [accountId, action.threadId],
    );
    return { ...action, messageIds: rows.map((r) => r.id) };
  } catch (err) {
    console.warn("Could not resolve message ids for action:", err);
    return action;
  }
}

export async function executeEmailAction(
  accountId: string,
  rawAction: EmailAction,
): Promise<ActionResult> {
  const action = await withMessageIds(accountId, rawAction);

  // 1. Optimistic UI update
  applyOptimisticUpdate(action);

  // 2. Local DB update
  try {
    await applyLocalDbUpdate(accountId, action);
  } catch (err) {
    console.warn("Local DB update failed:", err);
  }

  // 3. If offline, queue
  if (!useUIStore.getState().isOnline) {
    await enqueuePendingOperation(
      accountId,
      action.type,
      getResourceId(action),
      actionToParams(action),
    );
    return { success: true, queued: true };
  }

  // 4. Try online execution
  try {
    const data = await executeViaProvider(accountId, action);
    return { success: true, data };
  } catch (err) {
    const classified = classifyError(err);

    if (classified.isRetryable) {
      // Queue for retry
      await enqueuePendingOperation(
        accountId,
        action.type,
        getResourceId(action),
        actionToParams(action),
      );
      return { success: true, queued: true };
    }

    // Permanent error — revert optimistic update
    revertOptimisticUpdate(action);
    console.error(`Email action ${action.type} failed permanently:`, err);
    return { success: false, error: classified.message };
  }
}

// ---------------------------------------------------------------------------
// Bulk actions
// ---------------------------------------------------------------------------

/** How many provider calls a bulk action keeps in flight at once. */
export const BULK_CONCURRENCY = 6;

export interface BulkTarget {
  accountId: string;
  threadId: string;
}

/**
 * Run one action over many threads.
 *
 * A selection used to be handled with `for … await`, one server round trip
 * after another, so trashing forty mails took forty seconds and the rows left
 * the list one per second. The optimistic removal now happens for the whole
 * selection at once, and the provider calls run a few at a time — enough to
 * be quick, few enough that Gmail's per-user rate limit does not start
 * refusing them (a refused call is queued and retried, which reads as "it
 * came back"). Failures are collected, never thrown: one bad thread must not
 * stop the rest of the sweep.
 *
 * @param removes whether the action takes the thread out of the list, so the
 *   rows can fade together up front
 */
export async function runBulkAction(
  targets: BulkTarget[],
  run: (target: BulkTarget) => Promise<unknown>,
  { removes = false, concurrency = BULK_CONCURRENCY } = {},
): Promise<{ failed: number }> {
  if (targets.length === 0) return { failed: 0 };
  if (removes) {
    useThreadStore.getState().beginThreadRemoval(targets.map((t) => t.threadId));
  }

  let failed = 0;
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const target = targets[next++]!;
      try {
        await run(target);
      } catch (err) {
        failed++;
        console.error("Bulk action failed for thread", target.threadId, err);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, targets.length) }, worker),
  );
  return { failed };
}

// ---------------------------------------------------------------------------
// Execute a queued operation (used by queue processor)
// ---------------------------------------------------------------------------

export async function executeQueuedAction(
  accountId: string,
  operationType: string,
  params: Record<string, unknown>,
): Promise<void> {
  const action = { type: operationType, ...params } as EmailAction;
  const data = await executeViaProvider(accountId, action);
  if (action.type === "sendMessage") await persistSentMessageAndNotify(accountId, action.threadId, data);
}

// ---------------------------------------------------------------------------
// Convenience wrappers
// ---------------------------------------------------------------------------

export function archiveThread(
  accountId: string,
  threadId: string,
  messageIds: string[],
): Promise<ActionResult> {
  return executeEmailAction(accountId, {
    type: "archive",
    threadId,
    messageIds,
  });
}

export function trashThread(
  accountId: string,
  threadId: string,
  messageIds: string[],
): Promise<ActionResult> {
  return executeEmailAction(accountId, {
    type: "trash",
    threadId,
    messageIds,
  });
}

export function permanentDeleteThread(
  accountId: string,
  threadId: string,
  messageIds: string[],
): Promise<ActionResult> {
  return executeEmailAction(accountId, {
    type: "permanentDelete",
    threadId,
    messageIds,
  });
}

export function markThreadRead(
  accountId: string,
  threadId: string,
  messageIds: string[],
  read: boolean,
): Promise<ActionResult> {
  return executeEmailAction(accountId, {
    type: "markRead",
    threadId,
    messageIds,
    read,
  });
}

export function starThread(
  accountId: string,
  threadId: string,
  messageIds: string[],
  starred: boolean,
): Promise<ActionResult> {
  return executeEmailAction(accountId, {
    type: "star",
    threadId,
    messageIds,
    starred,
  });
}

export function spamThread(
  accountId: string,
  threadId: string,
  messageIds: string[],
  isSpam: boolean,
): Promise<ActionResult> {
  return executeEmailAction(accountId, {
    type: "spam",
    threadId,
    messageIds,
    isSpam,
  });
}

export function moveThread(
  accountId: string,
  threadId: string,
  messageIds: string[],
  folderPath: string,
): Promise<ActionResult> {
  return executeEmailAction(accountId, {
    type: "moveToFolder",
    threadId,
    messageIds,
    folderPath,
  });
}

export function addThreadLabel(
  accountId: string,
  threadId: string,
  labelId: string,
): Promise<ActionResult> {
  return executeEmailAction(accountId, {
    type: "addLabel",
    threadId,
    labelId,
  });
}

export function removeThreadLabel(
  accountId: string,
  threadId: string,
  labelId: string,
): Promise<ActionResult> {
  return executeEmailAction(accountId, {
    type: "removeLabel",
    threadId,
    labelId,
  });
}

export async function sendEmail(
  accountId: string,
  rawBase64Url: string,
  threadId?: string,
): Promise<ActionResult> {
  const result = await executeEmailAction(accountId, {
    type: "sendMessage",
    rawBase64Url,
    threadId,
  });

  // Persist a Gmail sent message before notifying views. IMAP providers do
  // this as part of sendMessage because the SMTP response has no message ID.
  if (result.success && !result.queued) await persistSentMessageAndNotify(accountId, threadId, result.data);

  return result;
}

async function persistSentMessageAndNotify(
  accountId: string,
  threadId: string | undefined,
  data: unknown,
): Promise<void> {
  const result = data as { id?: string; storedLocally?: boolean } | undefined;
  const messageId = result?.id;
  if (messageId && !result?.storedLocally) {
    try {
      const provider = await getEmailProvider(accountId);
      const parsed = await provider.fetchMessage(messageId);
      const candidateThreadId = threadId || parsed.threadId || messageId;
      const existingLabels = threadId ? await getThreadLabelIds(accountId, threadId) : [];
      const rows = await (await getDb()).select<{ message_count: number; subject: string | null; is_read: number; is_starred: number; is_important: number; has_attachments: number }[]>(
        "SELECT message_count, subject, is_read, is_starred, is_important, has_attachments FROM threads WHERE account_id = $1 AND id = $2",
        [accountId, candidateThreadId],
      );
      const existing = rows[0];
      const localThreadId = existing ? candidateThreadId : parsed.threadId || candidateThreadId;
      await upsertThread({
        id: localThreadId, accountId, subject: existing?.subject ?? parsed.subject,
        snippet: parsed.snippet, lastMessageAt: parsed.date,
        messageCount: (existing?.message_count ?? 0) + 1,
        isRead: (existing?.is_read ?? 1) === 1, isStarred: (existing?.is_starred ?? 0) === 1,
        isImportant: (existing?.is_important ?? 0) === 1,
        hasAttachments: (existing?.has_attachments ?? 0) === 1 || parsed.hasAttachments,
      });
      await upsertMessage({
        id: parsed.id, accountId, threadId: localThreadId,
        fromAddress: parsed.fromAddress, fromName: parsed.fromName,
        toAddresses: parsed.toAddresses, ccAddresses: parsed.ccAddresses,
        bccAddresses: parsed.bccAddresses, replyTo: parsed.replyTo,
        subject: parsed.subject, snippet: parsed.snippet, date: parsed.date,
        isRead: true, isStarred: parsed.isStarred, bodyHtml: parsed.bodyHtml,
        bodyText: parsed.bodyText, rawSize: parsed.rawSize, internalDate: parsed.internalDate,
        messageIdHeader: parsed.messageIdHeader, referencesHeader: parsed.referencesHeader,
        inReplyToHeader: parsed.inReplyToHeader, dispositionNotificationTo: parsed.dispositionNotificationTo,
      });
      const labels = threadId ? existingLabels : await getThreadLabelIds(accountId, localThreadId);
      await setThreadLabels(accountId, localThreadId, [...new Set([...labels, "SENT"])]);
    } catch (err) {
      console.warn("Could not persist sent Gmail message locally:", err);
    }
  }
  window.dispatchEvent(new CustomEvent("sndmail-message-sent", { detail: { accountId, threadId, messageId } }));
  window.dispatchEvent(new Event("sndmail-sync-done"));
}

export function createDraft(
  accountId: string,
  rawBase64Url: string,
  threadId?: string,
): Promise<ActionResult> {
  return executeEmailAction(accountId, {
    type: "createDraft",
    rawBase64Url,
    threadId,
  });
}

export function updateDraft(
  accountId: string,
  draftId: string,
  rawBase64Url: string,
  threadId?: string,
): Promise<ActionResult> {
  return executeEmailAction(accountId, {
    type: "updateDraft",
    draftId,
    rawBase64Url,
    threadId,
  });
}

export function deleteDraft(
  accountId: string,
  draftId: string,
): Promise<ActionResult> {
  return executeEmailAction(accountId, { type: "deleteDraft", draftId });
}
