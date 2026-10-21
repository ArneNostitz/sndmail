/**
 * @deprecated Fallback Gmail sync engine — not the ingestion owner.
 *
 * The bundled Rust helper (`sndmail-worker`, `src-tauri/src/worker/mail.rs`) is
 * the single ingestion owner on macOS: it runs the Gmail History/IDLE and IMAP
 * IDLE loops, refreshes credentials, writes messages and posts notifications,
 * and it keeps doing that while the app window is closed.
 *
 * This module survives only for hosts where the worker cannot run (development
 * builds without an installed helper, and non-macOS targets). It must never run
 * beside the worker: `syncManager.runSync()` routes every request to the worker
 * whenever `backgroundWorkerOwnsSync()` is true, which is the only supported
 * way to call it. Do not add new callers.
 */
import { GmailClient } from "./client";
import { reportError } from "@/stores/toastStore";
import { parseGmailMessage, type ParsedMessage } from "./messageParser";
import { upsertLabel } from "../db/labels";
import { upsertThread, setThreadLabels } from "../db/threads";
import { upsertMessage } from "../db/messages";
import { upsertAttachment } from "../db/attachments";
import { updateAccountSyncState } from "../db/accounts";
import { shouldNotifyForMessage, queueNewEmailNotification } from "../notifications/notificationManager";
import { applyFiltersToMessages, messagesRequestingNotify } from "../filters/filterEngine";
import { getSetting } from "../db/settings";
import { getMutedThreadIds } from "../db/threads";
import { getThreadCategory } from "../db/threadCategories";
import { getVipSenders } from "../db/notificationVips";
import { getPendingOpsForResource } from "../db/pendingOperations";

async function loadAutoArchiveCategories(): Promise<Set<string>> {
  const raw = await getSetting("auto_archive_categories");
  if (!raw) return new Set();
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

export interface SyncProgress {
  phase: "labels" | "threads" | "messages" | "done";
  current: number;
  total: number;
}

export type SyncProgressCallback = (progress: SyncProgress) => void;

/**
 * Store a fetched thread's data (messages, labels, attachments) into the local DB.
 * Optionally pass autoArchiveCategories and client to enable auto-archiving.
 */
async function processAndStoreThread(
  thread: { id: string },
  accountId: string,
  parsedMessages: ParsedMessage[],
  client?: GmailClient,
  autoArchiveCategories?: Set<string>,
): Promise<void> {
  const lastMessage = parsedMessages[parsedMessages.length - 1]!;
  const firstMessage = parsedMessages[0]!;

  const allLabelIds = new Set<string>();
  for (const msg of parsedMessages) {
    for (const lid of msg.labelIds) {
      allLabelIds.add(lid);
    }
  }

  const isRead = parsedMessages.every((m) => m.isRead);
  const isStarred = parsedMessages.some((m) => m.isStarred);
  const isImportant = allLabelIds.has("IMPORTANT");
  const hasAttachments = parsedMessages.some((m) => m.hasAttachments);

  await upsertThread({
    id: thread.id,
    accountId,
    subject: firstMessage.subject,
    snippet: lastMessage.snippet,
    lastMessageAt: lastMessage.date,
    messageCount: parsedMessages.length,
    isRead,
    isStarred,
    isImportant,
    hasAttachments,
  });

  // Gmail files anything the account transmitted as Sent, relayed app mail
  // included. To the reader that mail arrived; Sent is for what they wrote.
  if (allLabelIds.has("SENT") && allLabelIds.has("INBOX")) {
    try {
      const { shouldKeepSentLabel, cachedOwnAddresses } = await import("@/services/gmail/sentPrune");
      const own = await cachedOwnAddresses(accountId);
      if (!shouldKeepSentLabel(parsedMessages, own)) allLabelIds.delete("SENT");
    } catch (err) {
      console.warn("Could not check Sent placement:", err);
    }
  }

  await setThreadLabels(accountId, thread.id, [...allLabelIds]);

  // Rule-based categorization for inbox threads
  if (allLabelIds.has("INBOX")) {
    const { getThreadCategoryWithManual, setThreadCategory } = await import("@/services/db/threadCategories");
    const existing = await getThreadCategoryWithManual(accountId, thread.id);
    // Skip if manually categorized
    if (!existing || !existing.isManual) {
      const { categorizeByRules } = await import("@/services/categorization/ruleEngine");
      const category = categorizeByRules({
        labelIds: [...allLabelIds],
        fromAddress: lastMessage.fromAddress,
        listUnsubscribe: lastMessage.listUnsubscribe,
      });
      await setThreadCategory(accountId, thread.id, category, false);

      // Auto-archive if category matches
      if (client && autoArchiveCategories && autoArchiveCategories.has(category) && category !== "Primary") {
        try {
          await client.modifyThread(thread.id, undefined, ["INBOX"]);
          allLabelIds.delete("INBOX");
          await setThreadLabels(accountId, thread.id, [...allLabelIds]);
        } catch (err) {
          console.error(`Failed to auto-archive thread ${thread.id}:`, err);
        }
      }

      // Hold thread if delivery schedule is active for this category
      if (category !== "Primary") {
        try {
          const { getBundleRule, holdThread, getNextDeliveryTime } = await import("@/services/db/bundleRules");
          const rule = await getBundleRule(accountId, category);
          if (rule?.delivery_enabled && rule.delivery_schedule) {
            const schedule = JSON.parse(rule.delivery_schedule);
            const heldUntil = getNextDeliveryTime(schedule);
            await holdThread(accountId, thread.id, category, heldUntil);
          }
        } catch (err) {
          console.error(`Failed to check bundle rule for thread ${thread.id}:`, err);
        }
      }
    }
  }

  await Promise.all(parsedMessages.map(async (parsed) => {
    await upsertMessage({
      id: parsed.id,
      accountId,
      threadId: parsed.threadId,
      fromAddress: parsed.fromAddress,
      fromName: parsed.fromName,
      toAddresses: parsed.toAddresses,
      ccAddresses: parsed.ccAddresses,
      bccAddresses: parsed.bccAddresses,
      replyTo: parsed.replyTo,
      subject: parsed.subject,
      snippet: parsed.snippet,
      date: parsed.date,
      isRead: parsed.isRead,
      isStarred: parsed.isStarred,
      bodyHtml: parsed.bodyHtml,
      bodyText: parsed.bodyText,
      rawSize: parsed.rawSize,
      internalDate: parsed.internalDate,
      listUnsubscribe: parsed.listUnsubscribe,
      listUnsubscribePost: parsed.listUnsubscribePost,
      authResults: parsed.authResults,
      messageIdHeader: parsed.messageIdHeader,
      inReplyToHeader: parsed.inReplyToHeader,
      referencesHeader: parsed.referencesHeader,
      dispositionNotificationTo: parsed.dispositionNotificationTo,
    });

    await Promise.all(parsed.attachments.map((att) =>
      upsertAttachment({
        id: `${parsed.id}_${att.gmailAttachmentId}`,
        messageId: parsed.id,
        accountId,
        filename: att.filename,
        mimeType: att.mimeType,
        size: att.size,
        gmailAttachmentId: att.gmailAttachmentId,
        contentId: att.contentId,
        isInline: att.isInline,
      }),
    ));
  }));

  // Rejoin conversations Gmail split — by the headers where they link, and by
  // subject plus a shared correspondent where they do not
  try {
    const { linkSplitThreads, linkThreadsBySubject } = await import("@/services/threading/threadLinker");
    await linkSplitThreads(accountId);
    await linkThreadsBySubject(accountId);
  } catch (err) {
    reportError("Could not link split conversations", err);
  }

  // Count incoming read receipts against the sent messages they acknowledge
  try {
    const { processReadReceiptReports, backfillStoredReadReceipts } =
      await import("@/services/email/readReceipts");
    await processReadReceiptReports(accountId, parsedMessages);
    // Receipts stored before they were understood carry no report part, so
    // they need recognising from what did get stored
    await backfillStoredReadReceipts(accountId);
    // Threads stored before the Sent rule existed
    const { pruneRelayedSentLabels, cachedOwnAddresses } = await import("@/services/gmail/sentPrune");
    await pruneRelayedSentLabels(accountId, await cachedOwnAddresses(accountId));
  } catch (err) {
    reportError("Could not process read receipts", err);
  }
}

/**
 * Sync all labels for an account.
 */
export async function syncLabels(
  client: GmailClient,
  accountId: string,
): Promise<void> {
  const response = await client.listLabels();
  await Promise.all(response.labels.map((label) =>
    upsertLabel({
      id: label.id,
      accountId,
      name: label.name,
      type: label.type,
      colorBg: label.color?.backgroundColor ?? null,
      colorFg: label.color?.textColor ?? null,
    }),
  ));
}

/**
 * Perform an initial full sync: fetch all threads from the last N days.
 */
export async function initialSync(
  client: GmailClient,
  accountId: string,
  daysBack = 365,
  onProgress?: SyncProgressCallback,
): Promise<void> {
  // Phase 1: Sync labels
  onProgress?.({ phase: "labels", current: 0, total: 1 });
  await syncLabels(client, accountId);
  onProgress?.({ phase: "labels", current: 1, total: 1 });

  // Phase 2: Fetch thread list
  const afterDate = new Date();
  afterDate.setDate(afterDate.getDate() - daysBack);
  const afterStr = `${afterDate.getFullYear()}/${afterDate.getMonth() + 1}/${afterDate.getDate()}`;

  const threadStubs: { id: string }[] = [];
  let pageToken: string | undefined;

  onProgress?.({ phase: "threads", current: 0, total: 0 });

  do {
    const response = await client.listThreads({
      maxResults: 100,
      pageToken,
      q: `after:${afterStr}`,
    });

    if (response.threads) {
      threadStubs.push(...response.threads.map((t) => ({ id: t.id })));
    }

    pageToken = response.nextPageToken;
    onProgress?.({
      phase: "threads",
      current: threadStubs.length,
      total: threadStubs.length + (pageToken ? 100 : 0), // estimate
    });
  } while (pageToken);

  // Phase 3: Fetch and store each thread's details
  let historyId = "0";

  // Load auto-archive categories once for the whole sync
  const autoArchiveCategories = await loadAutoArchiveCategories();

  let progress = 0;
  await parallelLimit(
    threadStubs.map((stub) => async () => {
      onProgress?.({
        phase: "messages",
        current: ++progress,
        total: threadStubs.length,
      });

      try {
        const thread = await client.getThread(stub.id, "full");

        if (BigInt(thread.historyId) > BigInt(historyId)) {
          historyId = thread.historyId;
        }

        if (!thread.messages || thread.messages.length === 0) return;

        const parsedMessages = thread.messages.map(parseGmailMessage);
        await processAndStoreThread(thread, accountId, parsedMessages, client, autoArchiveCategories);
      } catch (err) {
        console.error(`Failed to sync thread ${stub.id}:`, err);
      }
    }),
    10,
  );

  // Store the latest history ID for delta sync
  await updateAccountSyncState(accountId, historyId);

  onProgress?.({
    phase: "done",
    current: threadStubs.length,
    total: threadStubs.length,
  });
}

/**
 * Delta sync: fetch only changes since last sync using history API.
 */
/**
 * Process a batch of promises with limited concurrency.
 */
async function parallelLimit<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
): Promise<T[]> {
  const results: T[] = [];
  let index = 0;

  async function next(): Promise<void> {
    while (index < tasks.length) {
      const i = index++;
      results[i] = await tasks[i]!();
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => next());
  await Promise.all(workers);
  return results;
}

/**
 * Delta sync: fetch only changes since last sync using history API.
 */
export async function deltaSync(
  client: GmailClient,
  accountId: string,
  lastHistoryId: string,
): Promise<void> {
  try {
    // Paginate through all history pages
    const affectedThreadIds = new Set<string>();
    const newInboxMessageIds = new Set<string>();
    let latestHistoryId = lastHistoryId;
    let pageToken: string | undefined;

    do {
      const response = await client.getHistory(lastHistoryId, undefined, pageToken);
      latestHistoryId = response.historyId;

      if (response.history) {
        for (const item of response.history) {
          if (item.messagesAdded) {
            for (const added of item.messagesAdded) {
              affectedThreadIds.add(added.message.threadId);
              // Track new unread inbox messages for notifications
              const labels = added.message.labelIds ?? [];
              if (labels.includes("INBOX") && labels.includes("UNREAD")) {
                newInboxMessageIds.add(added.message.id);
              }
            }
          }
          if (item.messagesDeleted) {
            for (const deleted of item.messagesDeleted) {
              affectedThreadIds.add(deleted.message.threadId);
            }
          }
          if (item.labelsAdded) {
            for (const labeled of item.labelsAdded) {
              affectedThreadIds.add(labeled.message.threadId);
            }
          }
          if (item.labelsRemoved) {
            for (const unlabeled of item.labelsRemoved) {
              affectedThreadIds.add(unlabeled.message.threadId);
            }
          }
        }
      }

      pageToken = response.nextPageToken;
    } while (pageToken);

    if (affectedThreadIds.size === 0) {
      await updateAccountSyncState(accountId, latestHistoryId);
      return;
    }

    // Load settings once for the whole sync cycle
    const autoArchiveCategories = await loadAutoArchiveCategories();
    const mutedThreadIds = await getMutedThreadIds(accountId);
    const smartNotifications = (await getSetting("smart_notifications")) !== "false";
    const notifyCategories = new Set(
      ((await getSetting("notify_categories")) ?? "Primary").split(",").map((s) => s.trim()).filter(Boolean),
    );
    const vipSenders = smartNotifications ? await getVipSenders(accountId) : new Set<string>();
    // Mailboxes the user chose to hear from. Never set means every account —
    // the setting has not been touched. Set and empty means none of them.
    const notifyAccountsSetting = await getSetting("notify_accounts");
    const allowedAccounts = notifyAccountsSetting === null
      ? undefined
      : new Set(notifyAccountsSetting.split(",").filter(Boolean));

    // Re-fetch affected threads in parallel (max 5 concurrent)
    const threadIds = [...affectedThreadIds];
    await parallelLimit(
      threadIds.map((threadId) => async () => {
        try {
          // Skip metadata overwrite for threads with pending local changes
          const pendingOps = await getPendingOpsForResource(accountId, threadId);
          if (pendingOps.length > 0) {
            console.log(`[deltaSync] Skipping thread ${threadId}: has ${pendingOps.length} pending local ops`);
            return;
          }

          const thread = await client.getThread(threadId, "full");

          if (!thread.messages || thread.messages.length === 0) return;

          const parsedMessages = thread.messages.map(parseGmailMessage);
          await processAndStoreThread(thread, accountId, parsedMessages, client, autoArchiveCategories);

          // Auto-archive muted threads that reappear in INBOX
          if (mutedThreadIds.has(threadId)) {
            const hasInbox = parsedMessages.some((m) => m.labelIds.includes("INBOX"));
            if (hasInbox) {
              try {
                await client.modifyThread(threadId, undefined, ["INBOX"]);
                await setThreadLabels(accountId, threadId,
                  [...new Set(parsedMessages.flatMap((m) => m.labelIds))].filter((l) => l !== "INBOX"),
                );
              } catch (err) {
                console.error(`Failed to auto-archive muted thread ${threadId}:`, err);
              }
            }
          }

          // One-time codes and sign-in links, before the ordinary notification:
          // a login code is worthless a minute later, so it gets announced (and
          // copied) whatever the category filters say
          try {
            const { processIncomingCodes } = await import("@/services/otp/otpManager");
            await processIncomingCodes(
              parsedMessages
                .filter((m) => newInboxMessageIds.has(m.id))
                .map((m) => ({
                  id: m.id,
                  threadId: m.threadId,
                  accountId,
                  subject: m.subject,
                  bodyText: m.bodyText,
                  bodyHtml: m.bodyHtml,
                  date: m.date,
                  fromName: m.fromName,
                  fromAddress: m.fromAddress,
                })),
            );
          } catch (err) {
            reportError("Could not check for login codes", err);
          }

          // Rules that ask to be told about a match, evaluated before the
          // filters run: archiving a message should not silence it
          const notifyRequestedIds = await messagesRequestingNotify(
            accountId,
            parsedMessages
              .filter((m) => newInboxMessageIds.has(m.id))
              .map((m) => ({
                id: m.id,
                fromAddress: m.fromAddress,
                subject: m.subject,
                toAddresses: m.toAddresses,
              })),
          );

          // Send desktop notifications for new unread inbox messages (smart-filtered)
          // Skip notifications for muted threads
          for (const parsed of parsedMessages) {
            if (newInboxMessageIds.has(parsed.id) && !mutedThreadIds.has(threadId)) {
              const fromAddr = parsed.fromAddress ?? undefined;
              if (shouldNotifyForMessage(
                smartNotifications,
                notifyCategories,
                vipSenders,
                await getThreadCategory(accountId, threadId),
                fromAddr,
                { allowedAccounts, accountId, ruleRequested: notifyRequestedIds.has(parsed.id) },
              )) {
                const sender = parsed.fromName ?? parsed.fromAddress ?? "Unknown";
                queueNewEmailNotification(
                  sender,
                  parsed.subject ?? "",
                  parsed.threadId,
                  accountId,
                  fromAddr,
                );
              }
            }
          }

          // Apply filters to new inbox messages in this thread
          const newMessages = parsedMessages.filter((m) => newInboxMessageIds.has(m.id));
          if (newMessages.length > 0) {
            try {
              await applyFiltersToMessages(accountId, newMessages);
            } catch (err) {
              console.error(`Failed to apply filters to thread ${threadId}:`, err);
            }

            // Apply smart labels (fire-and-forget, non-blocking)
            import("@/services/smartLabels/smartLabelManager")
              .then(({ applySmartLabelsToMessages }) => applySmartLabelsToMessages(accountId, newMessages))
              .catch((err) => console.error("Smart label error:", err));
          }
        } catch (err) {
          console.error(`Failed to re-sync thread ${threadId}:`, err);
        }
      }),
      10,
    );

    await updateAccountSyncState(accountId, latestHistoryId);

    // Fire-and-forget AI categorization for new threads
    import("@/services/ai/categorizationManager")
      .then(({ categorizeNewThreads }) => categorizeNewThreads(accountId))
      .catch((err) => console.error("Categorization error:", err));
  } catch (err) {
    // historyId might be too old — need full re-sync
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("404") || message.includes("historyId")) {
      console.warn("History ID expired, triggering full re-sync");
      throw new Error("HISTORY_EXPIRED");
    }
    throw err;
  }
}
