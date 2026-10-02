import { invoke } from "@tauri-apps/api/core";
import { getDb } from "@/services/db/connection";
import { getSetting } from "@/services/db/settings";
import { notify, reportError } from "@/stores/toastStore";
import { useUIStore } from "@/stores/uiStore";
import { drainWorkerPostprocessQueue } from "./postprocess";

let workerOwnsSync = false;
const WORKER_SYNC_TIMEOUT_MS = 15 * 60 * 1_000;
const WORKER_SYNC_POLL_MS = 500;

/** Install/attach once the frontend has migrated its database schema. */
export async function attachBackgroundWorker(): Promise<boolean> {
  if (await getSetting("background_worker_enabled") === "false") {
    const stillRunning = await invoke<boolean>("worker_is_running").catch(() => false);
    if (!stillRunning) return false;
    reportError("Background mail is still stopping", "The worker still owns the database. Restart sndmail after it exits.");
    workerOwnsSync = true;
    return true;
  }
  try {
    const alreadyReady = await invoke<boolean>("worker_is_ready");
    const installed = alreadyReady || await invoke<boolean>("worker_ensure_installed");
    if (!installed) return false;
    // A registered worker is the sole background sync owner even while it is
    // warming or reporting an error. Starting JS sync then would race its DB.
    workerOwnsSync = true;
    for (let attempt = 0; attempt < 10; attempt++) {
      if (await invoke<boolean>("worker_is_ready")) return true;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    notify("warning", "Background mail is starting", "The helper is registered but has not opened the mail database yet. Check its status in Settings if this persists.", null);
    return true;
  } catch (error) {
    reportError("Could not start background mail", error);
    // An existing login item may retry after this failure. Fall back to JS
    // only when there is definitively no registered or running helper.
    const registered = await invoke<boolean>("worker_is_registered").catch(() => true);
    const running = await invoke<boolean>("worker_is_running").catch(() => true);
    workerOwnsSync = registered || running;
    return workerOwnsSync;
  }
}

export function backgroundWorkerOwnsSync(): boolean {
  return workerOwnsSync;
}

export async function wakeBackgroundWorker(): Promise<void> {
  await invoke("worker_wake");
}

/** Reload Gmail push relay/account configuration and run one mail catch-up. */
export async function reconfigureBackgroundWorkerRelay(): Promise<void> {
  await invoke("worker_reconfigure_relay");
}

/** Queue a durable full reconciliation without starting a second sync owner. */
export async function requestWorkerResync(accountIds: string[]): Promise<void> {
  if (accountIds.length === 0) return;
  const db = await getDb();
  for (const accountId of accountIds) {
    await db.execute(
      "INSERT OR IGNORE INTO worker_resync_requests (account_id) VALUES ($1)",
      [accountId],
    );
  }
  await wakeBackgroundWorker();
  await waitForWorkerSync(accountIds, true);
}

/** Wake the helper and wait for the requested account batch to finish. */
export async function wakeBackgroundWorkerAndWait(accountIds: string[]): Promise<void> {
  if (accountIds.length === 0) return;
  const db = await getDb();
  for (const accountId of accountIds) {
    await db.execute(
      "INSERT OR IGNORE INTO worker_sync_requests (account_id) VALUES ($1)",
      [accountId],
    );
  }
  await wakeBackgroundWorker();
  await waitForWorkerSync(accountIds, true);
}

type WorkerMailStatus = { phase: string | null; error: string | null; account_id: string | null; updated_at: number | null };

async function readWorkerMailStatus(db: Awaited<ReturnType<typeof getDb>>): Promise<WorkerMailStatus> {
  const rows = await db.select<WorkerMailStatus[]>(
    "SELECT phase, error, account_id, updated_at FROM worker_mail_status WHERE id = 1",
  );
  return rows[0] ?? { phase: null, error: null, account_id: null, updated_at: null };
}

async function waitForWorkerSync(accountIds: string[], waitForResyncQueue: boolean): Promise<void> {
  const db = await getDb();
  const deadline = Date.now() + WORKER_SYNC_TIMEOUT_MS;
  let latestStatus = await readWorkerMailStatus(db);

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, WORKER_SYNC_POLL_MS));
    latestStatus = await readWorkerMailStatus(db);
    const accountRows = await db.select<{ account_id: string; phase: string; error: string | null }[]>(
      `SELECT account_id, phase, error FROM worker_mail_account_status WHERE account_id IN (${accountIds.map((_, i) => `$${i + 1}`).join(", ")})`,
      accountIds,
    );
    const requestTable = waitForResyncQueue ? "worker_resync_requests" : "worker_sync_requests";
    const failed = accountRows.find((row) => row.phase === "error");
    if (failed) {
      const [failedRequest] = await db.select<{ count: number }[]>(
        `SELECT COUNT(*) AS count FROM ${requestTable} WHERE account_id = $1`,
        [failed.account_id],
      );
      if ((failedRequest?.count ?? 0) === 0) {
        throw new Error(failed.error || `Mail sync failed for ${failed.account_id}.`);
      }
    }

    const pendingRows = await db.select<{ count: number }[]>(
      `SELECT COUNT(*) AS count FROM ${requestTable} WHERE account_id IN (${accountIds.map((_, i) => `$${i + 1}`).join(", ")})`,
      accountIds,
    );
    if ((pendingRows[0]?.count ?? 0) === 0 && latestStatus.phase !== "syncing") {
      return;
    }
  }

  const suffix = latestStatus.phase === "error" && latestStatus.error ? ` Last helper error: ${latestStatus.error}` : "";
  throw new Error(`The background mail helper did not confirm sync completion within 15 minutes.${suffix}`);
}

/** Refresh visible mail when the worker commits a completed account delta. */
export function observeWorkerChanges(): () => void {
  let stopped = false;
  let cursor: number | null = null;
  const poll = async () => {
    try {
      const db = await getDb();
      const rows = await db.select<{ seq: number | null }[]>(
        "SELECT MAX(seq) AS seq FROM worker_change_events",
      );
      const next = rows[0]?.seq ?? 0;
      if (cursor !== null && next > cursor && !stopped) {
        window.dispatchEvent(new Event("sndmail-sync-done"));
      }
      cursor = next;
      const [status] = await db.select<{ phase: string; error: string | null }[]>(
        "SELECT phase, error FROM worker_mail_status WHERE id = 1",
      );
      const [failures] = await db.select<{ count: number }[]>(
        "SELECT COUNT(*) AS count FROM worker_mail_account_status WHERE phase = 'error'",
      );
      if (!stopped) {
        const setSyncState = useUIStore.getState().setSyncState;
        if (status?.phase === "syncing") setSyncState("syncing", "Checking mail in background");
        else if (status?.phase === "error" || (failures?.count ?? 0) > 0) {
          setSyncState("error", status?.error ?? `${failures?.count ?? 1} mailbox sync error`);
        } else if (await invoke<boolean>("worker_is_ready").catch(() => false)) {
          setSyncState("idle");
        } else {
          setSyncState("error", "Background mail helper is unavailable");
        }
      }
      if (!stopped) void drainWorkerPostprocessQueue();
    } catch {
      // The worker creates its journal after the main schema is initialized.
    }
  };
  void poll();
  const interval = window.setInterval(() => { if (!stopped) void poll(); }, 3_000);
  return () => { stopped = true; window.clearInterval(interval); };
}
