import { getDb } from "./connection";

export interface DbThread {
  id: string;
  account_id: string;
  subject: string | null;
  snippet: string | null;
  last_message_at: number | null;
  message_count: number;
  is_read: number;
  is_starred: number;
  is_important: number;
  has_attachments: number;
  is_snoozed: number;
  snooze_until: number | null;
  is_pinned: number;
  is_muted: number;
  from_name: string | null;
  from_address: string | null;
  /**
   * Latest message from someone other than the user. Null when the whole
   * thread is the user's own mail (a sent message with no reply yet).
   */
  peer_name?: string | null;
  peer_address?: string | null;
}

export async function getThreadsForAccount(
  accountId: string,
  labelId?: string,
  limit = 50,
  offset = 0,
): Promise<DbThread[]> {
  const db = await getDb();
  if (labelId) {
    return db.select<DbThread[]>(
      `SELECT t.*, m.from_name, m.from_address FROM threads t
       INNER JOIN thread_labels tl ON tl.account_id = t.account_id AND tl.thread_id = t.id
       LEFT JOIN messages m ON m.account_id = t.account_id AND m.thread_id = t.id
         AND m.date = (SELECT MAX(m2.date) FROM messages m2 WHERE m2.account_id = t.account_id AND m2.thread_id = t.id)
       WHERE t.account_id = $1 AND tl.label_id = $2
       GROUP BY t.account_id, t.id
       ORDER BY t.is_pinned DESC, t.last_message_at DESC
       LIMIT $3 OFFSET $4`,
      [accountId, labelId, limit, offset],
    );
  }
  return db.select<DbThread[]>(
    `SELECT t.*, m.from_name, m.from_address FROM threads t
     LEFT JOIN messages m ON m.account_id = t.account_id AND m.thread_id = t.id
       AND m.date = (SELECT MAX(m2.date) FROM messages m2 WHERE m2.account_id = t.account_id AND m2.thread_id = t.id)
     WHERE t.account_id = $1
     ORDER BY t.is_pinned DESC, t.last_message_at DESC LIMIT $2 OFFSET $3`,
    [accountId, limit, offset],
  );
}

export async function getThreadsForCategory(
  accountId: string,
  category: string,
  limit = 50,
  offset = 0,
): Promise<DbThread[]> {
  const db = await getDb();
  if (category === "Primary") {
    // Primary includes threads with NULL category (uncategorized)
    return db.select<DbThread[]>(
      `SELECT t.*, m.from_name, m.from_address FROM threads t
       INNER JOIN thread_labels tl ON tl.account_id = t.account_id AND tl.thread_id = t.id
       LEFT JOIN thread_categories tc ON tc.account_id = t.account_id AND tc.thread_id = t.id
       LEFT JOIN messages m ON m.account_id = t.account_id AND m.thread_id = t.id
         AND m.date = (SELECT MAX(m2.date) FROM messages m2 WHERE m2.account_id = t.account_id AND m2.thread_id = t.id)
       WHERE t.account_id = $1 AND tl.label_id = 'INBOX' AND (tc.category IS NULL OR tc.category = 'Primary')
       GROUP BY t.account_id, t.id
       ORDER BY t.is_pinned DESC, t.last_message_at DESC
       LIMIT $2 OFFSET $3`,
      [accountId, limit, offset],
    );
  }
  return db.select<DbThread[]>(
    `SELECT t.*, m.from_name, m.from_address FROM threads t
     INNER JOIN thread_labels tl ON tl.account_id = t.account_id AND tl.thread_id = t.id
     INNER JOIN thread_categories tc ON tc.account_id = t.account_id AND tc.thread_id = t.id
     LEFT JOIN messages m ON m.account_id = t.account_id AND m.thread_id = t.id
       AND m.date = (SELECT MAX(m2.date) FROM messages m2 WHERE m2.account_id = t.account_id AND m2.thread_id = t.id)
     WHERE t.account_id = $1 AND tl.label_id = 'INBOX' AND tc.category = $2
     GROUP BY t.account_id, t.id
     ORDER BY t.is_pinned DESC, t.last_message_at DESC
     LIMIT $3 OFFSET $4`,
    [accountId, category, limit, offset],
  );
}

/**
 * Build the placeholder list for an `IN (...)` clause, e.g. `$1, $2, $3`.
 * Returns the placeholders and the index the next parameter should use.
 */
function inClause(count: number, startIndex = 1): { placeholders: string; nextIndex: number } {
  const placeholders = Array.from({ length: count }, (_, i) => `$${startIndex + i}`).join(", ");
  return { placeholders, nextIndex: startIndex + count };
}

/**
 * SQL that resolves the last message from someone other than the user, so the
 * list can name whoever replied instead of echoing the user's own address back
 * at them on a thread they started.
 *
 * Returns empty strings when there are no addresses to compare against, which
 * leaves the plain "last sender" behaviour intact.
 */
function peerJoin(
  ownAddresses: string[],
  startIndex: number,
): { select: string; join: string; params: string[]; nextIndex: number } {
  if (ownAddresses.length === 0) {
    return { select: "", join: "", params: [], nextIndex: startIndex };
  }
  const placeholders = ownAddresses
    .map((_, i) => `$${startIndex + i}`)
    .join(", ");
  return {
    select: ", pm.from_name AS peer_name, pm.from_address AS peer_address",
    join: `LEFT JOIN messages pm ON pm.account_id = t.account_id AND pm.thread_id = t.id
       AND pm.date = (SELECT MAX(m3.date) FROM messages m3
                      WHERE m3.account_id = t.account_id AND m3.thread_id = t.id
                        AND LOWER(COALESCE(m3.from_address, '')) NOT IN (${placeholders}))`,
    params: ownAddresses.map((a) => a.toLowerCase()),
    nextIndex: startIndex + ownAddresses.length,
  };
}

/**
 * Threads across several accounts, newest first — the unified inbox.
 *
 * Ordering is global rather than per-account, so a single list interleaves
 * every mailbox by date. Pass one account ID for the single-account view.
 */
export async function getThreadsForAccounts(
  accountIds: string[],
  labelId?: string | string[],
  limit = 50,
  offset = 0,
  ownAddresses: string[] = [],
): Promise<DbThread[]> {
  if (accountIds.length === 0) return [];
  const db = await getDb();
  const { placeholders, nextIndex } = inClause(accountIds.length);

  // Several labels at once is one list, not several: the combined view puts
  // INBOX and SENT side by side so a correspondence reads in order
  const labelIds = labelId === undefined ? [] : Array.isArray(labelId) ? labelId : [labelId];

  if (labelIds.length > 0) {
    const labels = inClause(labelIds.length, nextIndex);
    const peer = peerJoin(ownAddresses, labels.nextIndex);
    // A Gmail thread can contain messages with different system labels. Our
    // thread-level union may therefore contain both INBOX and SPAM; Spam wins
    // so a dangerous-looking red thread is never served in the Inbox.
    const excludeSpam = labelIds.includes("INBOX")
      ? `AND NOT EXISTS (
           SELECT 1 FROM thread_labels spam
           WHERE spam.account_id = t.account_id
             AND spam.thread_id = t.id
             AND spam.label_id = 'SPAM'
         )`
      : "";
    return db.select<DbThread[]>(
      `SELECT t.*, m.from_name, m.from_address${peer.select} FROM threads t
       INNER JOIN thread_labels tl ON tl.account_id = t.account_id AND tl.thread_id = t.id
       LEFT JOIN messages m ON m.account_id = t.account_id AND m.thread_id = t.id
         AND m.date = (SELECT MAX(m2.date) FROM messages m2 WHERE m2.account_id = t.account_id AND m2.thread_id = t.id)
       ${peer.join}
       WHERE t.account_id IN (${placeholders}) AND tl.label_id IN (${labels.placeholders})
         ${excludeSpam}
         AND ${HAS_REAL_MESSAGE} AND ${NOT_MERGED_AWAY}
       GROUP BY t.account_id, t.id
       ORDER BY t.is_pinned DESC, t.last_message_at DESC
       LIMIT $${peer.nextIndex} OFFSET $${peer.nextIndex + 1}`,
      [...accountIds, ...labelIds, ...peer.params, limit, offset],
    );
  }

  const peer = peerJoin(ownAddresses, nextIndex);
  return db.select<DbThread[]>(
    `SELECT t.*, m.from_name, m.from_address${peer.select} FROM threads t
     LEFT JOIN messages m ON m.account_id = t.account_id AND m.thread_id = t.id
       AND m.date = (SELECT MAX(m2.date) FROM messages m2 WHERE m2.account_id = t.account_id AND m2.thread_id = t.id)
     ${peer.join}
     WHERE t.account_id IN (${placeholders}) AND ${HAS_REAL_MESSAGE} AND ${NOT_MERGED_AWAY}
     ORDER BY t.is_pinned DESC, t.last_message_at DESC
     LIMIT $${peer.nextIndex} OFFSET $${peer.nextIndex + 1}`,
    [...accountIds, ...peer.params, limit, offset],
  );
}

/**
 * Specific threads by id across accounts, newest first. Search results live
 * anywhere in the mailbox, so they cannot be served by the label-scoped
 * queries above.
 */
export async function getThreadsByIds(
  accountIds: string[],
  threadIds: string[],
  ownAddresses: string[] = [],
): Promise<DbThread[]> {
  if (accountIds.length === 0 || threadIds.length === 0) return [];
  const db = await getDb();
  const accounts = inClause(accountIds.length);
  const ids = inClause(threadIds.length, accounts.nextIndex);
  const peer = peerJoin(ownAddresses, ids.nextIndex);
  return db.select<DbThread[]>(
    `SELECT t.*, m.from_name, m.from_address${peer.select} FROM threads t
     LEFT JOIN messages m ON m.account_id = t.account_id AND m.thread_id = t.id
       AND m.date = (SELECT MAX(m2.date) FROM messages m2 WHERE m2.account_id = t.account_id AND m2.thread_id = t.id)
     ${peer.join}
     WHERE t.account_id IN (${accounts.placeholders}) AND t.id IN (${ids.placeholders})
     ORDER BY t.last_message_at DESC`,
    [...accountIds, ...threadIds, ...peer.params],
  );
}

/** Category-filtered inbox threads across several accounts. */
export async function getThreadsForCategoryAcrossAccounts(
  accountIds: string[],
  category: string,
  limit = 50,
  offset = 0,
  ownAddresses: string[] = [],
): Promise<DbThread[]> {
  if (accountIds.length === 0) return [];
  const db = await getDb();
  const { placeholders, nextIndex } = inClause(accountIds.length);

  if (category === "Primary") {
    // Primary includes threads with NULL category (uncategorized)
    const peerPrimary = peerJoin(ownAddresses, nextIndex);
    return db.select<DbThread[]>(
      `SELECT t.*, m.from_name, m.from_address${peerPrimary.select} FROM threads t
       INNER JOIN thread_labels tl ON tl.account_id = t.account_id AND tl.thread_id = t.id
       LEFT JOIN thread_categories tc ON tc.account_id = t.account_id AND tc.thread_id = t.id
       LEFT JOIN messages m ON m.account_id = t.account_id AND m.thread_id = t.id
         AND m.date = (SELECT MAX(m2.date) FROM messages m2 WHERE m2.account_id = t.account_id AND m2.thread_id = t.id)
       ${peerPrimary.join}
       WHERE t.account_id IN (${placeholders}) AND tl.label_id = 'INBOX'
         AND NOT EXISTS (
           SELECT 1 FROM thread_labels spam
           WHERE spam.account_id = t.account_id
             AND spam.thread_id = t.id
             AND spam.label_id = 'SPAM'
         )
         AND (tc.category IS NULL OR tc.category = 'Primary')
         AND ${HAS_REAL_MESSAGE} AND ${NOT_MERGED_AWAY}
       GROUP BY t.account_id, t.id
       ORDER BY t.is_pinned DESC, t.last_message_at DESC
       LIMIT $${peerPrimary.nextIndex} OFFSET $${peerPrimary.nextIndex + 1}`,
      [...accountIds, ...peerPrimary.params, limit, offset],
    );
  }

  const peer = peerJoin(ownAddresses, nextIndex + 1);
  return db.select<DbThread[]>(
    `SELECT t.*, m.from_name, m.from_address${peer.select} FROM threads t
     INNER JOIN thread_labels tl ON tl.account_id = t.account_id AND tl.thread_id = t.id
     INNER JOIN thread_categories tc ON tc.account_id = t.account_id AND tc.thread_id = t.id
     LEFT JOIN messages m ON m.account_id = t.account_id AND m.thread_id = t.id
       AND m.date = (SELECT MAX(m2.date) FROM messages m2 WHERE m2.account_id = t.account_id AND m2.thread_id = t.id)
     ${peer.join}
     WHERE t.account_id IN (${placeholders}) AND tl.label_id = 'INBOX' AND tc.category = $${nextIndex}
       AND NOT EXISTS (
         SELECT 1 FROM thread_labels spam
         WHERE spam.account_id = t.account_id
           AND spam.thread_id = t.id
           AND spam.label_id = 'SPAM'
       )
       AND ${HAS_REAL_MESSAGE} AND ${NOT_MERGED_AWAY}
     GROUP BY t.account_id, t.id
     ORDER BY t.is_pinned DESC, t.last_message_at DESC
     LIMIT $${peer.nextIndex} OFFSET $${peer.nextIndex + 1}`,
    [...accountIds, category, ...peer.params, limit, offset],
  );
}

export async function upsertThread(thread: {
  id: string;
  accountId: string;
  subject: string | null;
  snippet: string | null;
  lastMessageAt: number | null;
  messageCount: number;
  isRead: boolean;
  isStarred: boolean;
  isImportant: boolean;
  hasAttachments: boolean;
}): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO threads (id, account_id, subject, snippet, last_message_at, message_count, is_read, is_starred, is_important, has_attachments)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT(account_id, id) DO UPDATE SET
       subject = $3, snippet = $4, last_message_at = $5, message_count = $6,
       is_read = $7, is_starred = $8, is_important = $9, has_attachments = $10`,
    [
      thread.id,
      thread.accountId,
      thread.subject,
      thread.snippet,
      thread.lastMessageAt,
      thread.messageCount,
      thread.isRead ? 1 : 0,
      thread.isStarred ? 1 : 0,
      thread.isImportant ? 1 : 0,
      thread.hasAttachments ? 1 : 0,
    ],
  );
}

export async function setThreadLabels(
  accountId: string,
  threadId: string,
  labelIds: string[],
): Promise<void> {
  const db = await getDb();
  // snd renders spam at thread level. If any synced message makes the thread
  // spam, do not persist a contradictory Inbox label alongside it.
  const normalizedLabelIds = labelIds.includes("SPAM")
    ? labelIds.filter((labelId) => labelId !== "INBOX")
    : labelIds;
  // Remove existing labels
  await db.execute(
    "DELETE FROM thread_labels WHERE account_id = $1 AND thread_id = $2",
    [accountId, threadId],
  );
  // Insert new labels
  for (const labelId of normalizedLabelIds) {
    await db.execute(
      "INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id) VALUES ($1, $2, $3)",
      [accountId, threadId, labelId],
    );
  }
}

/** Load labels for a page in one IPC query rather than one per row. */
export async function getLabelsForThreadPage(threads: { id: string; account_id: string }[]): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (!threads.length) return result;
  const db = await getDb();
  const accounts = [...new Set(threads.map((t) => t.account_id))];
  const ids = [...new Set(threads.map((t) => t.id))];
  const a = inClause(accounts.length);
  const t = inClause(ids.length, a.nextIndex);
  const rows = await db.select<{ account_id: string; thread_id: string; label_id: string }[]>(
    `SELECT account_id, thread_id, label_id FROM thread_labels WHERE account_id IN (${a.placeholders}) AND thread_id IN (${t.placeholders})`, [...accounts, ...ids]);
  for (const row of rows) {
    const key = JSON.stringify([row.account_id, row.thread_id]);
    result.set(key, [...(result.get(key) ?? []), row.label_id]);
  }
  return result;
}

export async function getThreadLabelIds(
  accountId: string,
  threadId: string,
): Promise<string[]> {
  const db = await getDb();
  const rows = await db.select<{ label_id: string }[]>(
    "SELECT label_id FROM thread_labels WHERE account_id = $1 AND thread_id = $2",
    [accountId, threadId],
  );
  return rows.map((r) => r.label_id);
}

export async function getThreadById(
  accountId: string,
  threadId: string,
): Promise<DbThread | undefined> {
  const db = await getDb();
  const rows = await db.select<DbThread[]>(
    `SELECT t.*, m.from_name, m.from_address FROM threads t
     LEFT JOIN messages m ON m.account_id = t.account_id AND m.thread_id = t.id
       AND m.date = (SELECT MAX(m2.date) FROM messages m2 WHERE m2.account_id = t.account_id AND m2.thread_id = t.id)
     WHERE t.account_id = $1 AND t.id = $2
     LIMIT 1`,
    [accountId, threadId],
  );
  return rows[0];
}

export async function getThreadCountForAccount(accountId: string): Promise<number> {
  const db = await getDb();
  const rows = await db.select<{ count: number }[]>(
    "SELECT COUNT(*) as count FROM threads WHERE account_id = $1",
    [accountId],
  );
  return rows[0]?.count ?? 0;
}

export async function getUnreadInboxCount(): Promise<number> {
  const db = await getDb();
  const rows = await db.select<{ count: number }[]>(
    `SELECT COUNT(*) as count FROM threads t
     INNER JOIN thread_labels tl ON tl.account_id = t.account_id AND tl.thread_id = t.id
     WHERE tl.label_id = 'INBOX' AND t.is_read = 0`,
  );
  return rows[0]?.count ?? 0;
}

export async function deleteThread(
  accountId: string,
  threadId: string,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "DELETE FROM threads WHERE account_id = $1 AND id = $2",
    [accountId, threadId],
  );
}

export async function deleteAllThreadsForAccount(
  accountId: string,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "DELETE FROM threads WHERE account_id = $1",
    [accountId],
  );
}

export async function pinThread(
  accountId: string,
  threadId: string,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE threads SET is_pinned = 1 WHERE account_id = $1 AND id = $2",
    [accountId, threadId],
  );
}

export async function unpinThread(
  accountId: string,
  threadId: string,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE threads SET is_pinned = 0 WHERE account_id = $1 AND id = $2",
    [accountId, threadId],
  );
}

export async function muteThread(
  accountId: string,
  threadId: string,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE threads SET is_muted = 1 WHERE account_id = $1 AND id = $2",
    [accountId, threadId],
  );
}

export async function unmuteThread(
  accountId: string,
  threadId: string,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE threads SET is_muted = 0 WHERE account_id = $1 AND id = $2",
    [accountId, threadId],
  );
}

export async function getMutedThreadIds(
  accountId: string,
): Promise<Set<string>> {
  const db = await getDb();
  const rows = await db.select<{ id: string }[]>(
    "SELECT id FROM threads WHERE account_id = $1 AND is_muted = 1",
    [accountId],
  );
  return new Set(rows.map((r) => r.id));
}

/**
 * Threads that still hold at least one message a person wrote.
 *
 * A thread whose every message is an MDN is machine chatter about mail the
 * user already has; it belongs in the "Opened" badge, not in a mailbox.
 */
const HAS_REAL_MESSAGE = `EXISTS (
       SELECT 1 FROM messages mr
       WHERE mr.account_id = t.account_id AND mr.thread_id = t.id
         AND mr.is_read_receipt = 0
     )`;

/** Threads the user never chose to keep in a list. */
/** A thread the user folded into another is no longer a row of its own. */
const NOT_MERGED_AWAY = "t.merged_into IS NULL";

const NOT_DRAFT_OR_BIN = `NOT EXISTS (
       SELECT 1 FROM thread_labels tlx
       WHERE tlx.account_id = t.account_id AND tlx.thread_id = t.id
         AND tlx.label_id IN ('DRAFT', 'TRASH', 'SPAM')
     )`;

/**
 * Every other conversation between the user and one person, newest first.
 *
 * "Between" is strict: a message counts only when it went directly from them
 * to the user or from the user to them. Appearing together in a Cc, or merely
 * being addressed by a third party, is not a conversation — matching loosely
 * turned "earlier with X" into the entire mailbox.
 *
 * Drafts, trash, spam and receipt-only threads are excluded, and the thread
 * already on screen is skipped.
 */
export async function getThreadsWithContact(
  accountId: string,
  email: string,
  excludeThreadId: string | null,
  ownAddresses: string[] = [],
  limit = 25,
  offset = 0,
): Promise<DbThread[]> {
  if (!email) return [];
  const db = await getDb();
  const peer = email.toLowerCase();
  const params: unknown[] = [accountId, excludeThreadId, peer, `%${peer}%`];
  let next = 5;

  // Direct exchange only. Without the user's own addresses to hand there is
  // nothing to pair against, so fall back to "they are on it, either way".
  let pairing: string;
  if (ownAddresses.length === 0) {
    pairing = `(LOWER(COALESCE(mc.from_address, '')) = $3
                OR LOWER(COALESCE(mc.to_addresses, '')) LIKE $4)`;
  } else {
    const mineIsSender: string[] = [];
    const mineIsRecipient: string[] = [];
    for (const own of ownAddresses) {
      mineIsSender.push(`$${next}`);
      params.push(own.toLowerCase());
      next++;
      mineIsRecipient.push(`LOWER(COALESCE(mc.to_addresses, '')) LIKE $${next}`);
      params.push(`%${own.toLowerCase()}%`);
      next++;
    }
    pairing = `(
                 (LOWER(COALESCE(mc.from_address, '')) = $3 AND (${mineIsRecipient.join(" OR ")}))
                 OR (LOWER(COALESCE(mc.from_address, '')) IN (${mineIsSender.join(", ")})
                     AND LOWER(COALESCE(mc.to_addresses, '')) LIKE $4)
               )`;
  }

  params.push(limit, offset);

  return db.select<DbThread[]>(
    `SELECT t.*, m.from_name, m.from_address FROM threads t
     LEFT JOIN messages m ON m.account_id = t.account_id AND m.thread_id = t.id
       AND m.date = (SELECT MAX(m2.date) FROM messages m2
                     WHERE m2.account_id = t.account_id AND m2.thread_id = t.id
                       AND m2.is_read_receipt = 0)
     WHERE t.account_id = $1
       AND ($2 IS NULL OR t.id != $2)
       AND ${NOT_DRAFT_OR_BIN}
       AND ${HAS_REAL_MESSAGE}
       AND ${NOT_MERGED_AWAY}
       AND EXISTS (
         SELECT 1 FROM messages mc
         WHERE mc.account_id = t.account_id AND mc.thread_id = t.id
           AND mc.is_read_receipt = 0
           AND ${pairing}
       )
     ORDER BY t.last_message_at DESC
     LIMIT $${next} OFFSET $${next + 1}`,
    params,
  );
}

/**
 * Fold one or more conversations into another.
 *
 * Threading is a guess — senders rewrite the subject, ticket systems drop
 * In-Reply-To, and one exchange lands in two threads. This is the user
 * overruling that. Nothing is rewritten: each merged thread keeps its own
 * rows and simply points at the thread it now reads as part of, so the merge
 * can be undone and a resync cannot lose anything.
 *
 * Merging is per account. A Gmail thread id, a draft and a send-as address
 * are only valid in the mailbox that issued them, so folding two mailboxes
 * into one row would break every action taken on it.
 */
/** Who decided two threads were one — the user, or one of the linker's rules. */
export type MergeReason = "manual" | "header" | "subject";

export async function mergeThreads(
  accountId: string,
  targetThreadId: string,
  sourceThreadIds: string[],
  mergedBy: MergeReason = "manual",
): Promise<void> {
  const sources = sourceThreadIds.filter((id) => id !== targetThreadId);
  if (sources.length === 0) return;
  const db = await getDb();
  const ids = inClause(sources.length, 4);

  // The reason is recorded so a rule that turns out to be wrong can be
  // undone for exactly the merges it made, without touching the user's own
  await db.execute(
    `UPDATE threads SET merged_into = $2, merged_by = $3
     WHERE account_id = $1 AND id IN (${ids.placeholders})`,
    [accountId, targetThreadId, mergedBy, ...sources],
  );

  // A thread already carrying others comes with them: re-point its followers
  // at the new target so a chain can never form.
  await db.execute(
    `UPDATE threads SET merged_into = $2
     WHERE account_id = $1 AND merged_into IN (${ids.placeholders})`,
    [accountId, targetThreadId, ...sources],
  );
}

/** Separate a thread again, leaving whatever else was merged alone. */
export async function unmergeThread(
  accountId: string,
  threadId: string,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE threads SET merged_into = NULL, merged_by = NULL WHERE account_id = $1 AND id = $2",
    [accountId, threadId],
  );
}

/** Ids folded into a thread, for loading its messages. Empty when none are. */
export async function getMergedThreadIds(
  accountId: string,
  threadId: string,
): Promise<string[]> {
  const db = await getDb();
  const rows = await db.select<{ id: string }[]>(
    "SELECT id FROM threads WHERE account_id = $1 AND merged_into = $2",
    [accountId, threadId],
  );
  return rows.map((r) => r.id);
}

/** Take one label off a thread, leaving the rest as they are. */
export async function removeThreadLabel(
  accountId: string,
  threadId: string,
  labelId: string,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "DELETE FROM thread_labels WHERE account_id = $1 AND thread_id = $2 AND label_id = $3",
    [accountId, threadId, labelId],
  );
}
