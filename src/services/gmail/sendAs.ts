import type { GmailClient } from "./client";
import { upsertAlias } from "../db/sendAsAliases";

interface GmailSendAsEntry {
  sendAsEmail: string;
  displayName?: string;
  replyToAddress?: string;
  isPrimary?: boolean;
  treatAsAlias?: boolean;
  verificationStatus?: string;
  signature?: string;
}

interface GmailSendAsResponse {
  sendAs: GmailSendAsEntry[];
}

/**
 * Fetch send-as aliases from Gmail API and store them locally.
 *
 * Needs the `gmail.settings.basic` scope. An account authorized before that
 * scope was requested gets a 403 here and has to be re-authorized in
 * Settings > Accounts before it can send from any of its other addresses.
 */
export async function fetchSendAsAliases(
  client: GmailClient,
  accountId: string,
): Promise<void> {
  let response: GmailSendAsResponse;
  try {
    response = await client.request<GmailSendAsResponse>("/settings/sendAs");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("403") || message.toLowerCase().includes("insufficient")) {
      throw new Error(
        "sndmail is not authorized to read your send-as addresses. Re-authorize this account in Settings > Accounts.",
      );
    }
    throw err;
  }

  if (!response.sendAs) return;

  for (const entry of response.sendAs) {
    await upsertAlias({
      accountId,
      email: entry.sendAsEmail,
      displayName: entry.displayName ?? null,
      replyToAddress: entry.replyToAddress ?? null,
      isPrimary: entry.isPrimary ?? false,
      treatAsAlias: entry.treatAsAlias ?? true,
      verificationStatus: entry.verificationStatus ?? "accepted",
    });
  }
}

/**
 * Register a send-as alias with Gmail, then sync the stored list.
 *
 * Addresses at a workspace domain alias (e.g. hello@reimedy.com for an
 * account on diracting.com) are accepted without verification; anything
 * else gets Gmail's usual verification mail and stays `pending` until the
 * user clicks the link Gmail sends.
 *
 * Needs the `gmail.settings.basic` scope — the same 403/`insufficient`
 * handling as `fetchSendAsAliases` applies.
 */
export async function createSendAsAlias(
  client: GmailClient,
  accountId: string,
  email: string,
  displayName?: string,
): Promise<void> {
  const body: Record<string, unknown> = {
    sendAsEmail: email,
    treatAsAlias: true,
  };
  if (displayName) body.displayName = displayName;

  try {
    await client.request("/settings/sendAs", {
      method: "POST",
      body: JSON.stringify(body),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("403") || message.toLowerCase().includes("insufficient")) {
      throw new Error(
        "sndmail is not authorized to change your send-as addresses. Re-authorize this account in Settings > Accounts.",
      );
    }
    throw err;
  }

  await fetchSendAsAliases(client, accountId);
}

/**
 * Remove a send-as alias on Gmail, then sync the stored list.
 */
export async function deleteSendAsAlias(
  client: GmailClient,
  accountId: string,
  email: string,
): Promise<void> {
  try {
    await client.request(
      `/settings/sendAs/${encodeURIComponent(email)}`,
      { method: "DELETE" },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("403") || message.toLowerCase().includes("insufficient")) {
      throw new Error(
        "sndmail is not authorized to change your send-as addresses. Re-authorize this account in Settings > Accounts.",
      );
    }
    throw err;
  }

  await fetchSendAsAliases(client, accountId);
}
