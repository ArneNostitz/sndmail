import { getDb } from "@/services/db/connection";
import { extractEmailAddresses, normalizeEmail } from "@/utils/emailUtils";

export interface AliasSuggestion {
  email: string;
  occurrences: number;
  lastSeen: number;
}

interface MessageAddressRow {
  from_address: string | null;
  to_addresses: string | null;
  cc_addresses: string | null;
  date: number;
}

const CANDIDATE_LIMIT = 2000;
const SUGGESTION_LIMIT = 10;

/**
 * Detect addresses that look like aliases of the user's own addresses: a
 * different domain on the same local part (workspace domain aliases arrive
 * exactly like this — mail to hello@reimedy.com lands in hello@diracting.com).
 *
 * Only incoming mail counts, so a message the user sent to a
 * similarly-named stranger never produces a suggestion.
 */
export function suggestAliasesFromMessageRows(
  rows: Pick<
    MessageAddressRow,
    "from_address" | "to_addresses" | "cc_addresses" | "date"
  >[],
  ownAddresses: string[],
): AliasSuggestion[] {
  const own = new Set(ownAddresses.map((address) => normalizeEmail(address)));
  const ownLocalParts = new Set(
    [...own].map((address) => address.split("@")[0] ?? ""),
  );
  const hits = new Map<string, AliasSuggestion>();

  for (const row of rows) {
    const from = row.from_address ? normalizeEmail(row.from_address) : null;
    if (from && own.has(from)) continue; // the user sent this one

    const headers = [row.to_addresses, row.cc_addresses];
    for (const header of headers) {
      for (const candidate of extractEmailAddresses(header)) {
        const email = normalizeEmail(candidate);
        if (!email.includes("@")) continue;
        if (own.has(email)) continue;
        if (!ownLocalParts.has(email.split("@")[0] ?? "")) continue;

        const existing = hits.get(email);
        if (existing) {
          existing.occurrences += 1;
          existing.lastSeen = Math.max(existing.lastSeen, row.date);
        } else {
          hits.set(email, { email, occurrences: 1, lastSeen: row.date });
        }
      }
    }
  }

  return [...hits.values()]
    .sort((a, b) => b.lastSeen - a.lastSeen || a.email.localeCompare(b.email))
    .slice(0, SUGGESTION_LIMIT);
}

/**
 * Suggest send-as aliases for one account from its recent messages.
 *
 * `ownAddresses` should be the account's own addresses — its address plus
 * its stored aliases (`collectOwnAddresses`) — so already-registered aliases
 * are never suggested again.
 */
export async function findAliasSuggestions(
  accountId: string,
  ownAddresses: string[],
): Promise<AliasSuggestion[]> {
  const db = await getDb();
  const rows = await db.select<MessageAddressRow[]>(
    `SELECT from_address, to_addresses, cc_addresses, date
     FROM messages WHERE account_id = $1
     ORDER BY date DESC LIMIT ${CANDIDATE_LIMIT}`,
    [accountId],
  );
  return suggestAliasesFromMessageRows(rows, ownAddresses);
}
