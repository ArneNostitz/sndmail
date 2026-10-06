import { getAliasesForAccount } from "@/services/db/sendAsAliases";
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
    own.add(account.email.trim().toLowerCase());
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
    for (const alias of aliases) own.add(alias.email.trim().toLowerCase());
  }

  return [...own];
}
