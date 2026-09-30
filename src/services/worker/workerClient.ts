import { invoke } from "@tauri-apps/api/core";
import { getDb } from "@/services/db/connection";
import { getSetting } from "@/services/db/settings";
import { notify, reportError } from "@/stores/toastStore";
import { useUIStore } from "@/stores/uiStore";
import { drainWorkerPostprocessQueue } from "./postprocess";

let workerOwnsSync = false;

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
  const db = await getDb();
  for (const accountId of accountIds) {
    await db.execute(
      "INSERT OR IGNORE INTO worker_resync_requests (account_id) VALUES ($1)",
      [accountId],
    );
  }
  await wakeBackgroundWorker();
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
