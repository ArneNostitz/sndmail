import { invoke } from "@tauri-apps/api/core";
import { reconfigureBackgroundWorkerRelay } from "./workerClient";

/** Secret-free view of a stored Commonplace relay grant. */
export interface RelayProfileSummary {
  profileId: string;
  accountIds: string[];
  scopes: string[];
}

/** List stored relay grants (profile id, covered accounts, scopes — never tokens). */
export async function listRelayProfiles(): Promise<RelayProfileSummary[]> {
  return invoke<RelayProfileSummary[]>("worker_list_relay_profiles");
}

/**
 * Change which accounts a relay grant covers without rotating its bearer
 * token. An empty list revokes the grant. The worker is asked to re-read its
 * grants so the change applies immediately.
 */
export async function updateRelayAccounts(
  profileId: string,
  accountIds: string[],
): Promise<void> {
  await invoke("worker_update_relay_accounts", { profileId, accountIds });
  await reconfigureBackgroundWorkerRelay().catch(() => {
    // The grant is stored either way; a worker that is not running will pick
    // it up on its next start.
  });
}
