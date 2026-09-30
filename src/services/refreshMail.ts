import { useAccountStore, listedAccountIds } from "@/stores/accountStore";
import { useUIStore } from "@/stores/uiStore";
import { getActiveLabel } from "@/router/navigate";
import { triggerSync } from "@/services/gmail/syncManager";
import { backgroundWorkerOwnsSync, wakeBackgroundWorker } from "@/services/worker/workerClient";

/**
 * Manually refresh every mailbox the current list draws from — the avatar
 * refresh button and the F5 shortcut both land here.
 */
export function refreshMail(): void {
  const ids = listedAccountIds(useAccountStore.getState());
  if (ids.length === 0) return;
  useUIStore.getState().setSyncingFolder(getActiveLabel());
  if (backgroundWorkerOwnsSync()) {
    void wakeBackgroundWorker();
  } else {
    void triggerSync(ids);
  }
}
