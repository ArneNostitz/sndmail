import { getGmailClient } from "./tokenManager";
import {
  initialSync,
  deltaSync,
  type SyncProgress,
} from "./sync";
import { getAccount, clearAccountHistoryId } from "../db/accounts";
import { getSetting } from "../db/settings";
import { getThreadCountForAccount, deleteAllThreadsForAccount } from "../db/threads";
import { deleteAllMessagesForAccount } from "../db/messages";
import { imapInitialSync, imapDeltaSync } from "../imap/imapSync";
import { clearAllFolderSyncStates } from "../db/folderSyncState";
import { ensureFreshToken } from "../oauth/oauthTokenManager";
import {
  backgroundWorkerOwnsSync,
  requestWorkerResync,
  wakeBackgroundWorkerAndWait,
} from "../worker/workerClient";

/** Map IMAP sync phases to the SyncProgress phases the UI understands. */
function mapImapPhase(phase: string): "labels" | "threads" | "messages" | "done" {
  if (phase === "folders") return "labels";
  if (phase === "threading" || phase === "storing_threads") return "threads";
  if (phase === "messages") return "messages";
  if (phase === "done") return "done";
  return phase as "labels" | "threads" | "messages" | "done";
}

let syncPromise: Promise<void> | null = null;
let pendingAccountIds: string[] | null = null;

export type SyncStatusCallback = (
  accountId: string,
  status: "syncing" | "done" | "error",
  progress?: SyncProgress,
  error?: string,
) => void;

let statusCallback: SyncStatusCallback | null = null;
let batchCompleteCallback: SyncBatchCompleteCallback | null = null;

export interface SyncBatchResult {
  accountIds: string[];
  failedAccountIds: string[];
}

export type SyncBatchCompleteCallback = (result: SyncBatchResult) => void;

export function onSyncStatus(cb: SyncStatusCallback): () => void {
  statusCallback = cb;
  return () => {
    statusCallback = null;
  };
}

/** Subscribe to the UI-visible boundary of a sync: once per account batch. */
export function onSyncBatchComplete(cb: SyncBatchCompleteCallback): () => void {
  batchCompleteCallback = cb;
  return () => {
    batchCompleteCallback = null;
  };
}

/**
 * Run a sync for a single Gmail API account (initial or delta).
 */
async function syncGmailAccount(accountId: string): Promise<void> {
  const client = await getGmailClient(accountId);
  const account = await getAccount(accountId);

  if (!account) {
    throw new Error("Account not found");
  }

  const syncPeriodStr = await getSetting("sync_period_days");
  const syncDays = parseInt(syncPeriodStr ?? "365", 10) || 365;

  if (account.history_id) {
    // Delta sync
    try {
      await deltaSync(client, accountId, account.history_id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err ?? "");
      if (message === "HISTORY_EXPIRED") {
        // Fallback to full sync
        await initialSync(client, accountId, syncDays, (progress) => {
          statusCallback?.(accountId, "syncing", progress);
        });
      } else {
        throw err;
      }
    }
  } else {
    // First time — full initial sync
    await initialSync(client, accountId, syncDays, (progress) => {
      statusCallback?.(accountId, "syncing", progress);
    });
  }
}

/**
 * Run a sync for a single IMAP account (initial or delta).
 */
async function syncImapAccount(accountId: string): Promise<void> {
  const account = await getAccount(accountId);

  if (!account) {
    throw new Error("Account not found");
  }

  // Refresh OAuth2 token before syncing (if applicable)
  if (account.auth_method === "oauth2") {
    await ensureFreshToken(account);
  }

  const syncPeriodStr = await getSetting("sync_period_days");
  const syncDays = parseInt(syncPeriodStr ?? "365", 10) || 365;

  if (account.history_id) {
    // Delta sync — IMAP uses folder-level UID tracking
    const result = await imapDeltaSync(accountId, syncDays);

    // Recovery: if delta sync found nothing new but the DB has no threads,
    // the previous initial sync likely failed or stored data incorrectly.
    // Force a full re-sync to recover.
    if (result.messages.length === 0) {
      const threadCount = await getThreadCountForAccount(accountId);
      if (threadCount === 0) {
        console.warn(`[syncManager] IMAP delta sync returned 0 new messages and DB has 0 threads for ${accountId} — forcing full re-sync`);
        await clearAccountHistoryId(accountId);
        await clearAllFolderSyncStates(accountId);
        await imapInitialSync(accountId, syncDays, (progress) => {
          statusCallback?.(accountId, "syncing", {
            phase: mapImapPhase(progress.phase),
            current: progress.current,
            total: progress.total,
          });
        });
      }
    }
  } else {
    // First time — full initial sync
    await imapInitialSync(accountId, syncDays, (progress) => {
      statusCallback?.(accountId, "syncing", {
        phase: mapImapPhase(progress.phase),
        current: progress.current,
        total: progress.total,
      });
    });
  }
}

/**
 * Run a sync for a single account (initial or delta).
 * Routes to Gmail or IMAP sync based on account provider.
 */
async function syncAccountInternal(accountId: string): Promise<boolean> {
  try {
    const account = await getAccount(accountId);

    if (!account) {
      throw new Error("Account not found");
    }

    statusCallback?.(accountId, "syncing");

    console.log(`[syncManager] Syncing account ${accountId} (provider=${account.provider}, history_id=${account.history_id ?? "null"})`);

    if (account.provider === "caldav") {
      // Calendar-only accounts are synchronized by the Calendar page.
      return true;
    }

    if (account.provider === "imap") {
      await syncImapAccount(accountId);
    } else {
      await syncGmailAccount(accountId);
    }

    // Always emit "done" when an initial sync completes (clears the bar).
    // Also emit for delta syncs that fell back to initial (recovery re-sync)
    // since those emit progress via statusCallback inside syncImapAccount.
    statusCallback?.(accountId, "done");
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err ?? "Unknown error");
    console.error(`[syncManager] Sync failed for account ${accountId}:`, message);
    statusCallback?.(accountId, "error", undefined, message);
    return false;
  }
}

async function runSync(accountIds: string[]): Promise<void> {
  // The native helper is the single ingestion owner whenever it is installed
  // and holds the mail database. Running the TypeScript engines beside it would
  // write the same messages from two processes, duplicate notifications and
  // race the worker's credential refreshes — so a request from the UI (manual
  // refresh, retry, account switch) is forwarded to the worker instead.
  if (backgroundWorkerOwnsSync()) {
    await wakeBackgroundWorkerAndWait(accountIds);
    return;
  }

  if (syncPromise) {
    // Queue these accounts, merging with any already-pending IDs
    const existing = new Set(pendingAccountIds ?? []);
    for (const id of accountIds) existing.add(id);
    pendingAccountIds = [...existing];
    return syncPromise;
  }

  syncPromise = (async () => {
    const failedAccountIds: string[] = [];
    try {
      for (const id of accountIds) {
        if (!(await syncAccountInternal(id))) failedAccountIds.push(id);
      }
    } finally {
      syncPromise = null;
    }

    batchCompleteCallback?.({ accountIds, failedAccountIds });

    // Drain the queue — if something was queued while we were syncing, run it now
    if (pendingAccountIds) {
      const queued = pendingAccountIds;
      pendingAccountIds = null;
      await runSync(queued);
    }
  })();

  return syncPromise;
}

/**
 * Run sync for a single account, queuing if already running.
 */
export async function syncAccount(accountId: string): Promise<void> {
  return runSync([accountId]);
}

/**
 * Catch up once when the app starts. Subsequent Gmail and IMAP work is driven
 * by the push relay and IDLE notifications, with manual refresh as fallback.
 */
export function startInitialSync(accountIds: string[]): void {
  void runSync(accountIds).catch((error) => {
    console.warn("[syncManager] Catch-up sync did not complete:", error);
  });
}

/**
 * Trigger an immediate sync for all provided accounts.
 * Waits for completion even if another push or manual sync is in progress.
 */
export async function triggerSync(accountIds: string[]): Promise<void> {
  await runSync(accountIds);
}

/**
 * Clear history IDs and perform a full re-sync for all provided accounts.
 * This re-downloads all threads from scratch.
 */
export async function forceFullSync(accountIds: string[]): Promise<void> {
  if (backgroundWorkerOwnsSync()) {
    // A durable worker resync request is the worker's own full reconciliation.
    await requestWorkerResync(accountIds);
    return;
  }
  for (const id of accountIds) {
    await clearAccountHistoryId(id);
  }
  await runSync(accountIds);
}

/**
 * Delete all local data for a single account and re-sync from scratch.
 * Removes all threads, messages, history ID, and IMAP folder sync states,
 * then runs a fresh initial sync.
 */
export async function resyncAccount(accountId: string): Promise<void> {
  if (backgroundWorkerOwnsSync()) {
    // Never delete rows underneath a running worker; ask it to reconcile.
    await requestWorkerResync([accountId]);
    return;
  }
  await deleteAllThreadsForAccount(accountId);
  await deleteAllMessagesForAccount(accountId);
  await clearAccountHistoryId(accountId);
  await clearAllFolderSyncStates(accountId);
  await runSync([accountId]);
}
