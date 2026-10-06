import { getAliasesForAccount } from "@/services/db/sendAsAliases";
import { getDb } from "@/services/db/connection";
import type { Account } from "@/stores/accountStore";

/**
 * Every address that belongs to the user across the given accounts — the
 * account addresses plus their verified send-as aliases.
 *
 * The thread list uses this to name whoever replied instead of echoing the
 * user's own address back at them on a thread they started.
 */
export async function collectOwnAddresses(
  accounts: Account[],
  accountIds: string[],
): Promise<string[]> {
  const wanted = new Set(accountIds);
  const own = new Set<string>();

  for (const account of accounts) {
    if (!wanted.has(account.id)) continue;
    own.add(account.email.toLowerCase());
  }

  const aliasLists = await Promise.all(
    accountIds.map(async (id) => {
      try {
        return await getAliasesForAccount(id);
      } catch {
        // An account whose aliases cannot be read just contributes nothing
        return [];
      }
    }),
  );
  for (const aliases of aliasLists) {
    for (const alias of aliases) own.add(alias.email.toLowerCase());
  }

  // Send-as aliases can predate the local alias cache (or belong to an IMAP
  // mailbox, where Gmail's send-as endpoint is unavailable). Sent messages
  // are an authoritative local record of identities this mailbox owns, so
  // include their From addresses as a fallback. This prevents a just-sent
  // alias from becoming the apparent outside sender in the inbox list.
  try {
    const db = await getDb();
    const sentRows = await Promise.all(accountIds.map((id) => db.select<{ from_address: string | null }[]>(
      `SELECT DISTINCT LOWER(TRIM(m.from_address)) AS from_address
       FROM messages m
       WHERE m.account_id = $1
         AND m.from_address IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM thread_labels tl
           WHERE tl.account_id = m.account_id
             AND tl.thread_id = m.thread_id
             AND tl.label_id = 'SENT'
         )`,
      [id],
    )));
    for (const rows of sentRows) {
      for (const row of rows) {
        if (row.from_address) own.add(row.from_address);
      }
    }
  } catch {
    // The account and alias addresses above are still sufficient when the DB
    // is unavailable during startup.
  }

  return [...own];
}
