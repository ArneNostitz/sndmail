import { getDb } from "./connection";

export interface DbMessage {
  id: string;
  account_id: string;
  thread_id: string;
  from_address: string | null;
  from_name: string | null;
  to_addresses: string | null;
  cc_addresses: string | null;
  bcc_addresses: string | null;
  reply_to: string | null;
  subject: string | null;
  snippet: string | null;
  date: number;
  is_read: number;
  is_starred: number;
  body_html: string | null;
  body_text: string | null;
  body_cached: number;
  raw_size: number | null;
  internal_date: number | null;
  list_unsubscribe: string | null;
  list_unsubscribe_post: string | null;
  auth_results: string | null;
  message_id_header: string | null;
  references_header: string | null;
  in_reply_to_header: string | null;
  imap_uid: number | null;
  imap_folder: string | null;
  disposition_notification_to: string | null;
  read_receipt_status: ReadReceiptStatus | null;
  read_receipt_count: number;
  read_receipt_last_at: number | null;
  /** 1 when the message is itself an MDN — machine chatter, not mail. */
  is_read_receipt: number;
}

/**
 * How a read-receipt request was handled: "sent"/"dismissed" for requests the
 * user answered, "processed" for an incoming MDN already counted against the
 * original sent message.
 */
export type ReadReceiptStatus = "sent" | "dismissed" | "processed";

export async function getMessagesForThread(
  accountId: string,
  threadId: string,
): Promise<DbMessage[]> {
  const db = await getDb();
  return db.select<DbMessage[]>(
    `SELECT * FROM messages WHERE account_id = $1 AND thread_id = $2
       AND is_read_receipt = 0
     ORDER BY date ASC`,
    [accountId, threadId],
  );
}

/**
 * Messages for several threads at once, oldest first.
 *
 * One query rather than one per thread — the past-conversations list below a
 * thread can span dozens of them.
 */
export async function getMessagesForThreads(
  accountId: string,
  threadIds: string[],
): Promise<DbMessage[]> {
  if (threadIds.length === 0) return [];
  const db = await getDb();
  const placeholders = threadIds.map((_, i) => `$${i + 2}`).join(", ");
  return db.select<DbMessage[]>(
    `SELECT * FROM messages WHERE account_id = $1 AND thread_id IN (${placeholders})
       AND is_read_receipt = 0
     ORDER BY date ASC`,
    [accountId, ...threadIds],
  );
}

export async function upsertMessage(msg: {
  id: string;
  accountId: string;
  threadId: string;
  fromAddress: string | null;
  fromName: string | null;
  toAddresses: string | null;
  ccAddresses: string | null;
  bccAddresses: string | null;
  replyTo: string | null;
  subject: string | null;
  snippet: string | null;
  date: number;
  isRead: boolean;
  isStarred: boolean;
  bodyHtml: string | null;
  bodyText: string | null;
  rawSize: number | null;
  internalDate: number | null;
  listUnsubscribe?: string | null;
  listUnsubscribePost?: string | null;
  authResults?: string | null;
  messageIdHeader?: string | null;
  referencesHeader?: string | null;
  inReplyToHeader?: string | null;
  imapUid?: number | null;
  imapFolder?: string | null;
  dispositionNotificationTo?: string | null;
}): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO messages (id, account_id, thread_id, from_address, from_name, to_addresses, cc_addresses, bcc_addresses, reply_to, subject, snippet, date, is_read, is_starred, body_html, body_text, body_cached, raw_size, internal_date, list_unsubscribe, list_unsubscribe_post, auth_results, message_id_header, references_header, in_reply_to_header, imap_uid, imap_folder, disposition_notification_to)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28)
     ON CONFLICT(account_id, id) DO UPDATE SET
       from_address = $4, from_name = $5, to_addresses = $6, cc_addresses = $7,
       bcc_addresses = $8, reply_to = $9, subject = $10, snippet = $11,
       date = $12, is_read = $13, is_starred = $14,
       body_html = COALESCE($15, body_html), body_text = COALESCE($16, body_text),
       body_cached = CASE WHEN $15 IS NOT NULL THEN 1 ELSE body_cached END,
       raw_size = $18, internal_date = $19, list_unsubscribe = $20, list_unsubscribe_post = $21,
       auth_results = $22, message_id_header = COALESCE($23, message_id_header),
       references_header = COALESCE($24, references_header),
       in_reply_to_header = COALESCE($25, in_reply_to_header),
       imap_uid = COALESCE($26, imap_uid), imap_folder = COALESCE($27, imap_folder),
       disposition_notification_to = COALESCE($28, disposition_notification_to)`,
    [
      msg.id,
      msg.accountId,
      msg.threadId,
      msg.fromAddress,
      msg.fromName,
      msg.toAddresses,
      msg.ccAddresses,
      msg.bccAddresses,
      msg.replyTo,
      msg.subject,
      msg.snippet,
      msg.date,
      msg.isRead ? 1 : 0,
      msg.isStarred ? 1 : 0,
      msg.bodyHtml,
      msg.bodyText,
      msg.bodyHtml ? 1 : 0,
      msg.rawSize,
      msg.internalDate,
      msg.listUnsubscribe ?? null,
      msg.listUnsubscribePost ?? null,
      msg.authResults ?? null,
      msg.messageIdHeader ?? null,
      msg.referencesHeader ?? null,
      msg.inReplyToHeader ?? null,
      msg.imapUid ?? null,
      msg.imapFolder ?? null,
      msg.dispositionNotificationTo ?? null,
    ],
  );
}

/**
 * Record how the user handled a read-receipt request, so the prompt is not
 * shown again for the same message.
 */
export async function setReadReceiptStatus(
  accountId: string,
  messageId: string,
  status: ReadReceiptStatus,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE messages SET read_receipt_status = $1 WHERE account_id = $2 AND id = $3",
    [status, accountId, messageId],
  );
}

export async function deleteMessage(
  accountId: string,
  messageId: string,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "DELETE FROM messages WHERE account_id = $1 AND id = $2",
    [accountId, messageId],
  );
}

export async function updateMessageThreadIds(
  accountId: string,
  messageIds: string[],
  threadId: string,
): Promise<void> {
  const db = await getDb();
  // SQLite variable limit is 999; process in chunks
  for (let i = 0; i < messageIds.length; i += 500) {
    const chunk = messageIds.slice(i, i + 500);
    const placeholders = chunk.map((_, idx) => `$${idx + 3}`).join(", ");
    await db.execute(
      `UPDATE messages SET thread_id = $1 WHERE account_id = $2 AND id IN (${placeholders})`,
      [threadId, accountId, ...chunk],
    );
  }
}

/** Fill a message body that was not cached during its original sync. */
export async function updateMissingMessageBody(
  accountId: string,
  messageId: string,
  bodyHtml: string | null,
  bodyText: string | null,
): Promise<void> {
  if (!bodyHtml && !bodyText) return;
  const db = await getDb();
  await db.execute(
    `UPDATE messages SET
       body_html = CASE WHEN body_html IS NULL OR body_html = '' THEN COALESCE($1, body_html) ELSE body_html END,
       body_text = CASE WHEN body_text IS NULL OR body_text = '' THEN COALESCE($2, body_text) ELSE body_text END,
       body_cached = 1
     WHERE account_id = $3 AND id = $4
       AND (body_html IS NULL OR body_html = '')
       AND (body_text IS NULL OR body_text = '')`,
    [bodyHtml, bodyText, accountId, messageId],
  );
}

export async function deleteAllMessagesForAccount(
  accountId: string,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "DELETE FROM messages WHERE account_id = $1",
    [accountId],
  );
}

/**
 * Get recent sent messages for an account, matching from_address to account email.
 * Used for writing style analysis.
 */
export async function getRecentSentMessages(
  accountId: string,
  accountEmail: string,
  limit: number = 15,
): Promise<DbMessage[]> {
  const db = await getDb();
  return db.select<DbMessage[]>(
    `SELECT * FROM messages
     WHERE account_id = $1 AND LOWER(from_address) = LOWER($2)
       AND body_text IS NOT NULL AND LENGTH(body_text) > 50
     ORDER BY date DESC LIMIT $3`,
    [accountId, accountEmail, limit],
  );
}
