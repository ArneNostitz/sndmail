import type { GmailClient } from "./client";
import { upsertAlias, getAliasesForAccount, deleteAlias } from "../db/sendAsAliases";

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
 * Fetch send-as aliases from the Gmail API and reconcile the local list.
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

  const googleList = response.sendAs ?? [];
  for (const entry of googleList) {
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

  // The Google list is the authoritative source for a Gmail account:
  // aliases can only be added or removed Google-side (the Gmail API's
  // create/delete/verify methods are restricted to service accounts with
  // delegated domain-wide authority — a personal OAuth client always gets
  // 403). Drop local rows that no longer exist on Google so a refresh
  // clears an alias the user removed in Gmail.
  const googleEmails = new Set(
    googleList.map((e) => e.sendAsEmail.toLowerCase()),
  );
  for (const row of await getAliasesForAccount(accountId)) {
    if (!googleEmails.has(row.email.toLowerCase())) {
      await deleteAlias(row.id);
    }
  }
}
