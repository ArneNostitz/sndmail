/**
 * Read receipts via Message Disposition Notifications (RFC 8098).
 *
 * Senders request a receipt with a `Disposition-Notification-To` header;
 * we honour that request by sending back a `multipart/report` message with
 * a `message/disposition-notification` part. Whether a receipt is sent is
 * governed by the `read_receipt_response` setting: "ask" (default) shows a
 * banner, "always" answers automatically, "never" suppresses the prompt.
 */
import { base64UrlEncode, encodeMimeHeader } from "@/utils/emailBuilder";
import type { ParsedMessage } from "@/services/gmail/messageParser";
import type { DbMessage } from "@/services/db/messages";
import { setReadReceiptStatus } from "@/services/db/messages";
import { getAccount } from "@/services/db/accounts";
import { sendEmail } from "@/services/emailActions";

export type ReadReceiptResponseMode = "ask" | "always" | "never";

export async function getReadReceiptResponseMode(): Promise<ReadReceiptResponseMode> {
  const { getSetting } = await import("@/services/db/settings");
  const value = await getSetting("read_receipt_response");
  return value === "always" || value === "never" ? value : "ask";
}

/**
 * Extract the first email address from a Disposition-Notification-To header
 * value (`"Name" <a@b>, c@d` → `a@b`). Returns null when no address is found.
 */
export function parseReceiptAddress(header: string | null): string | null {
  if (!header) return null;
  const angleMatch = header.match(/<([^>]+@[^>]+)>/);
  if (angleMatch?.[1]) return angleMatch[1].trim();
  const bareMatch = header.match(/[^\s,<>"']+@[^\s,<>"']+/);
  return bareMatch?.[0] ?? null;
}

/**
 * RFC 8098 §2.1 advises confirming with the user when the receipt would go
 * to a different domain than the sender — a mismatch is a common tracking /
 * harvesting trick. Used to downgrade "always" to an explicit prompt.
 */
export function isReceiptAddressSuspicious(
  receiptAddress: string,
  fromAddress: string | null,
): boolean {
  if (!fromAddress) return true;
  const receiptDomain = receiptAddress.split("@")[1]?.toLowerCase();
  const fromDomain = fromAddress.split("@")[1]?.toLowerCase();
  if (!receiptDomain || !fromDomain) return true;
  return receiptDomain !== fromDomain;
}

/**
 * A message deserves a read-receipt prompt when the sender requested one,
 * the user has not answered yet, and we did not send the message ourselves.
 */
export function needsReadReceipt(
  message: Pick<
    DbMessage,
    "disposition_notification_to" | "read_receipt_status" | "from_address"
  >,
  ownAddresses: ReadonlySet<string>,
): boolean {
  if (!message.disposition_notification_to) return false;
  if (message.read_receipt_status) return false;
  if (!parseReceiptAddress(message.disposition_notification_to)) return false;
  if (message.from_address && ownAddresses.has(message.from_address.toLowerCase())) {
    return false;
  }
  return true;
}

export interface MdnOptions {
  /** Account owner sending the receipt. */
  fromEmail: string;
  /** Where the receipt goes (parsed Disposition-Notification-To address). */
  toAddress: string;
  /** Subject of the message being acknowledged. */
  originalSubject: string | null;
  /** RFC 2822 Message-ID of the message being acknowledged, if known. */
  originalMessageId: string | null;
  /** True when sent by the "always" setting rather than a user click. */
  automatic: boolean;
}

/**
 * Build a multipart/report MDN (RFC 8098) and encode it base64url, ready for
 * EmailProvider.sendMessage.
 */
export function buildMdnRaw(opts: MdnOptions): string {
  const boundary = `----=_MDN_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const subject = `Read: ${opts.originalSubject ?? "(no subject)"}`;
  const domain = opts.fromEmail.includes("@")
    ? opts.fromEmail.split("@")[1]
    : "sndmail.local";
  const messageId = `<${Date.now()}.${Math.random().toString(36).slice(2, 10)}@${domain}>`;
  const dispositionMode = opts.automatic
    ? "automatic-action/MDN-sent-automatically"
    : "manual-action/MDN-sent-manually";

  const lines: string[] = [
    `From: ${opts.fromEmail}`,
    `To: ${opts.toAddress}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageId}`,
    `Subject: ${encodeMimeHeader(subject)}`,
    `MIME-Version: 1.0`,
  ];
  if (opts.originalMessageId) {
    lines.push(`In-Reply-To: ${opts.originalMessageId}`);
    lines.push(`References: ${opts.originalMessageId}`);
  }
  lines.push(
    `Content-Type: multipart/report; report-type=disposition-notification; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    `The message sent to ${opts.fromEmail}`,
    `with subject "${opts.originalSubject ?? "(no subject)"}"`,
    "has been displayed on the recipient's computer.",
    "",
    "This is no guarantee that the message has been read or understood.",
    "",
    `--${boundary}`,
    "Content-Type: message/disposition-notification",
    "",
    "Reporting-UA: snd",
    `Final-Recipient: rfc822;${opts.fromEmail}`,
  );
  if (opts.originalMessageId) {
    lines.push(`Original-Message-ID: ${opts.originalMessageId}`);
  }
  lines.push(
    `Disposition: ${dispositionMode}; displayed`,
    "",
    `--${boundary}--`,
  );

  return base64UrlEncode(lines.join("\r\n"));
}

/**
 * Send an MDN for a displayed message and record that it was answered.
 * Goes through emailActions, so an offline send is queued like any other.
 */
export async function sendReadReceipt(
  message: DbMessage,
  automatic: boolean,
): Promise<void> {
  const toAddress = parseReceiptAddress(message.disposition_notification_to);
  if (!toAddress) return;

  const account = await getAccount(message.account_id);
  if (!account) throw new Error(`Account ${message.account_id} not found`);

  const raw = buildMdnRaw({
    fromEmail: account.email,
    toAddress,
    originalSubject: message.subject,
    originalMessageId: message.message_id_header,
    automatic,
  });

  // No threadId: the receipt is a standalone message, not part of the thread
  const result = await sendEmail(message.account_id, raw);
  if (!result.success) {
    throw new Error(result.error ?? "Failed to send read receipt");
  }

  await setReadReceiptStatus(message.account_id, message.id, "sent");
}

/** Record that the user declined the request, so we stop asking. */
export async function dismissReadReceipt(message: DbMessage): Promise<void> {
  await setReadReceiptStatus(message.account_id, message.id, "dismissed");
}

// ---------------------------------------------------------------------------
// Incoming receipts — count "opened" on the original sent message
// ---------------------------------------------------------------------------

/** Pull the Original-Message-ID out of a message/disposition-notification part. */
export function parseMdnOriginalMessageId(report: string): string | null {
  const match = report.match(/^Original-Message-ID:[ \t]*(<[^>\r\n]+>)/im);
  return match?.[1] ?? null;
}

/**
 * Subjects the common clients give a receipt. Used only to recognise a
 * receipt whose machine-readable part never reached the database — the
 * report part is the real test.
 */
/**
 * The same subjects as SQL LIKE patterns, so the database can do the
 * narrowing. Kept deliberately loose — `looksLikeReadReceipt` is the actual
 * test, this only decides which rows are worth reading.
 */
const SUBJECT_LIKE = [
  "%read receipt%",
  "%return receipt%",
  "%disposition notification%",
  "%Empfangsbest%",
  "%Lesebest%",
  "%de r_ception%",
  "%Confirmaci_n de lectura%",
  "%Bevestiging van ontvangst%",
];

const RECEIPT_SUBJECTS = [
  /\bread receipt\b/i,
  /\breturn receipt\b/i,
  /\bdisposition notification\b/i,
  /Empfangsbest(ä|ae)tigung/i,
  /Lesebest(ä|ae)tigung/i,
  /Accus(é|e) de r(é|e)ception/i,
  /Confirmaci(ó|o)n de lectura/i,
  /Bevestiging van ontvangst/i,
];

/**
 * Whether a stored message is itself a read receipt rather than mail a person
 * wrote. A receipt is machine chatter about a message the user already has —
 * it belongs in a badge, not in the conversation.
 */
export function looksLikeReadReceipt(message: {
  subject: string | null;
  body_text: string | null;
  is_read_receipt?: number | null;
}): boolean {
  if (message.is_read_receipt === 1) return true;
  if (!message.subject) return false;
  if (!RECEIPT_SUBJECTS.some((p) => p.test(message.subject!))) return false;
  // The subject alone is too weak — a person can write "read receipt" in one.
  // Every client's boilerplate says the message was displayed, not read.
  const body = message.body_text ?? "";
  return /disposition|angezeigt|displayed|gelesen|affich|mostrado|weergegeven/i.test(body);
}

/**
 * Match incoming MDNs against the sent messages they acknowledge and bump
 * that message's opened counter. Each receipt is counted once — it is marked
 * "processed" afterwards, so re-syncing the same thread cannot double-count.
 * Called from Gmail and IMAP sync after new messages are stored.
 */
export async function processReadReceiptReports(
  accountId: string,
  messages: Pick<
    ParsedMessage,
    "id" | "mdnReport" | "date" | "fromAddress" | "inReplyToHeader" | "referencesHeader"
  >[],
): Promise<void> {
  const receipts = messages.filter(
    (m) => m.mdnReport !== null && m.mdnReport !== undefined,
  );
  if (receipts.length === 0) return;

  const { getDb } = await import("@/services/db/connection");
  const db = await getDb();

  for (const receipt of receipts) {
    try {
      const rows = await db.select<{ read_receipt_status: string | null }[]>(
        "SELECT read_receipt_status FROM messages WHERE account_id = $1 AND id = $2",
        [accountId, receipt.id],
      );
      // The receipt is machine chatter whether or not it can be attributed
      await db.execute(
        "UPDATE messages SET is_read_receipt = 1 WHERE account_id = $1 AND id = $2",
        [accountId, receipt.id],
      );
      if (rows[0]?.read_receipt_status === "processed") continue;

      const referenceHeader = receipt.inReplyToHeader ?? receipt.referencesHeader;
      const originalMessageId =
        parseMdnOriginalMessageId(receipt.mdnReport ?? "") ??
        referenceHeader?.match(/<[^>\r\n]+>/)?.[0] ??
        null;
      if (originalMessageId) {
        await db.execute(
          `UPDATE messages
           SET read_receipt_count = read_receipt_count + 1,
               read_receipt_last_at = MAX(COALESCE(read_receipt_last_at, 0), $1)
           WHERE account_id = $2 AND message_id_header = $3`,
          [receipt.date, accountId, originalMessageId],
        );
      } else if (receipt.fromAddress) {
        // Some providers keep the MDN content type but expose no report body.
        // Attribute it to the latest receipt-requesting mail sent to the
        // responder; this is the same conservative fallback as old-message
        // backfill and is independent of the receipt's display language.
        const originals = await db.select<{ id: string }[]>(
          `SELECT id FROM messages
           WHERE account_id = $1
             AND disposition_notification_to IS NOT NULL
             AND disposition_notification_to <> ''
             AND LOWER(COALESCE(to_addresses, '')) LIKE $2
             AND date <= $3
           ORDER BY date DESC LIMIT 1`,
          [accountId, `%${receipt.fromAddress.toLowerCase()}%`, receipt.date],
        );
        if (originals[0]?.id) {
          await db.execute(
            `UPDATE messages
             SET read_receipt_count = read_receipt_count + 1,
                 read_receipt_last_at = MAX(COALESCE(read_receipt_last_at, 0), $1)
             WHERE account_id = $2 AND id = $3`,
            [receipt.date, accountId, originals[0].id],
          );
        }
      }

      // Mark counted even without a match, so we never re-parse this receipt
      await setReadReceiptStatus(accountId, receipt.id, "processed");
    } catch (err) {
      console.error("Failed to process read receipt:", err);
    }
  }
}

/**
 * Flag receipts already sitting in the database and attribute them.
 *
 * Messages synced before receipts were understood kept no report part, and a
 * receipt carries no In-Reply-To to thread it back, so the exact
 * Original-Message-ID is gone. What remains is enough: a receipt is answered
 * by whoever we asked, so it belongs to the most recent message we sent to
 * that address which actually requested one.
 *
 * Runs once per sync; already-flagged receipts are skipped.
 */
export async function backfillStoredReadReceipts(accountId: string): Promise<number> {
  const { getDb } = await import("@/services/db/connection");
  const db = await getDb();

  // Narrow on the subject in SQL before touching a body. Selecting body_text
  // for every message shipped ~9MB per account across the IPC bridge on every
  // sync; the subject filter returns a handful of rows.
  const subjectFilter = SUBJECT_LIKE.map((_, i) => `subject LIKE $${i + 2}`).join(" OR ");
  const candidates = await db.select<{
    id: string;
    subject: string | null;
    body_text: string | null;
    from_address: string | null;
    date: number;
    read_receipt_status: string | null;
  }[]>(
    `SELECT id, subject, body_text, from_address, date, read_receipt_status
     FROM messages
     WHERE account_id = $1 AND is_read_receipt = 0 AND (${subjectFilter})`,
    [accountId, ...SUBJECT_LIKE],
  );

  let flagged = 0;
  for (const candidate of candidates) {
    if (!looksLikeReadReceipt(candidate)) continue;
    try {
      await db.execute(
        "UPDATE messages SET is_read_receipt = 1 WHERE account_id = $1 AND id = $2",
        [accountId, candidate.id],
      );
      flagged++;

      if (candidate.read_receipt_status === "processed") continue;

      // Attribute it to the message we asked this person to confirm
      const original = await db.select<{ id: string }[]>(
        `SELECT id FROM messages
         WHERE account_id = $1
           AND disposition_notification_to IS NOT NULL
           AND disposition_notification_to <> ''
           AND LOWER(COALESCE(to_addresses, '')) LIKE $2
           AND date <= $3
         ORDER BY date DESC LIMIT 1`,
        [accountId, `%${(candidate.from_address ?? "").toLowerCase()}%`, candidate.date],
      );
      const originalId = original[0]?.id;
      if (originalId) {
        await db.execute(
          `UPDATE messages
           SET read_receipt_count = read_receipt_count + 1,
               read_receipt_last_at = MAX(COALESCE(read_receipt_last_at, 0), $1)
           WHERE account_id = $2 AND id = $3`,
          [candidate.date, accountId, originalId],
        );
      }
      await setReadReceiptStatus(accountId, candidate.id, "processed");
    } catch (err) {
      console.error("Failed to backfill read receipt:", err);
    }
  }
  return flagged;
}
