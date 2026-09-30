import { getAllAccounts } from "@/services/db/accounts";
import { useAccountStore } from "@/stores/accountStore";
import { initializeClients, getGmailClient } from "@/services/gmail/tokenManager";
import { syncAccount } from "@/services/gmail/syncManager";
import { fetchSendAsAliases } from "@/services/gmail/sendAs";
import { backgroundWorkerOwnsSync, reconfigureBackgroundWorkerRelay } from "@/services/worker/workerClient";

/**
 * Bring the app up to date after an account was added.
 *
 * Reloads accounts into the store, re-initializes provider clients, kicks off
 * an immediate sync for the new mail account. Shared
 * by every entry point that can add an account (sidebar switcher, settings).
 */
export async function refreshAfterAccountAdded(): Promise<void> {
  const dbAccounts = await getAllAccounts();
  const mapped = dbAccounts.map((a) => ({
    id: a.id,
    email: a.email,
    displayName: a.display_name,
    avatarUrl: a.avatar_url,
    isActive: a.is_active === 1,
    provider: a.provider,
    color: a.color,
  }));
  useAccountStore.getState().setAccounts(mapped);

  // Re-initialize clients for the new account
  await initializeClients();

  const newest = mapped[mapped.length - 1];
  if (newest) {
    if (newest.provider !== "caldav") {
      // Calendar-only accounts wait until the Calendar page is opened.
      if (backgroundWorkerOwnsSync()) {
        void reconfigureBackgroundWorkerRelay().catch((error) =>
          console.warn("Could not refresh background worker account configuration:", error),
        );
      }
      else void syncAccount(newest.id);
    }

    // Fetch send-as aliases in the background (non-blocking, skip CalDAV-only accounts)
    if (newest.provider !== "caldav") {
      getGmailClient(newest.id)
        .then((client) => fetchSendAsAliases(client, newest.id))
        .catch((err) =>
          console.warn(`Failed to fetch send-as aliases for new account:`, err),
        );
    }
  }
}
