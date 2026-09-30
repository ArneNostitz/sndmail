import { getDb } from "@/services/db/connection";
import { applyFiltersToMessages } from "@/services/filters/filterEngine";
import { applySmartLabelsToMessages } from "@/services/smartLabels/smartLabelManager";
import { categorizeByRules } from "@/services/categorization/ruleEngine";
import { getThreadCategoryWithManual, setThreadCategory } from "@/services/db/threadCategories";
import { categorizeNewThreads } from "@/services/ai/categorizationManager";
import type { ParsedMessage } from "@/services/gmail/messageParser";

interface QueuedMessage {
  account_id: string;
  message_id: string;
  thread_id: string | null;
  from_address: string | null;
  from_name: string | null;
  to_addresses: string | null;
  cc_addresses: string | null;
  bcc_addresses: string | null;
  reply_to: string | null;
  subject: string | null;
  snippet: string | null;
  date: number | null;
  is_read: number | null;
  is_starred: number | null;
  body_html: string | null;
  body_text: string | null;
  raw_size: number | null;
  internal_date: number | null;
  list_unsubscribe: string | null;
  list_unsubscribe_post: string | null;
  auth_results: string | null;
  message_id_header: string | null;
  in_reply_to_header: string | null;
  references_header: string | null;
  disposition_notification_to: string | null;
  label_ids: string | null;
  attachment_count: number;
}

let draining = false;

/** Finish UI-owned rules for worker-delivered mail when the main app is open. */
export async function drainWorkerPostprocessQueue(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    const db = await getDb();
    // The helper creates this table after validating the main schema. A fresh
    // installation can reach this observer before the helper finishes startup.
    const rows = await db.select<QueuedMessage[]>(`
      SELECT q.account_id, q.message_id, m.thread_id, m.from_address, m.from_name,
             m.to_addresses, m.cc_addresses, m.bcc_addresses, m.reply_to,
             m.subject, m.snippet, m.date, m.is_read, m.is_starred,
             m.body_html, m.body_text, m.raw_size, m.internal_date,
             m.list_unsubscribe, m.list_unsubscribe_post, m.auth_results,
             m.message_id_header, m.in_reply_to_header, m.references_header,
             m.disposition_notification_to,
             (SELECT group_concat(label_id, char(31)) FROM thread_labels
              WHERE account_id = q.account_id AND thread_id = m.thread_id) AS label_ids,
             (SELECT COUNT(*) FROM attachments
              WHERE account_id = q.account_id AND message_id = q.message_id) AS attachment_count
      FROM worker_postprocess_queue q
      LEFT JOIN messages m ON m.account_id = q.account_id AND m.id = q.message_id
      ORDER BY q.created_at, q.account_id, q.message_id
      LIMIT 50
    `);
    const aiAccounts = new Set<string>();
    for (const row of rows) {
      if (!row.thread_id) {
        await db.execute("DELETE FROM worker_postprocess_queue WHERE account_id = $1 AND message_id = $2", [row.account_id, row.message_id]);
        continue;
      }
      const labels = row.label_ids?.split(String.fromCharCode(31)) ?? [];
      const parsed: ParsedMessage = {
        id: row.message_id,
        threadId: row.thread_id,
        fromAddress: row.from_address,
        fromName: row.from_name,
        toAddresses: row.to_addresses,
        ccAddresses: row.cc_addresses,
        bccAddresses: row.bcc_addresses,
        replyTo: row.reply_to,
        subject: row.subject,
        snippet: row.snippet ?? "",
        date: row.date ?? 0,
        isRead: row.is_read === 1,
        isStarred: row.is_starred === 1,
        bodyHtml: row.body_html,
        bodyText: row.body_text,
        rawSize: row.raw_size ?? 0,
        internalDate: row.internal_date ?? row.date ?? 0,
        labelIds: labels,
        hasAttachments: row.attachment_count > 0,
        attachments: [],
        listUnsubscribe: row.list_unsubscribe,
        listUnsubscribePost: row.list_unsubscribe_post,
        authResults: row.auth_results,
        messageIdHeader: row.message_id_header,
        inReplyToHeader: row.in_reply_to_header,
        referencesHeader: row.references_header,
        dispositionNotificationTo: row.disposition_notification_to,
        mdnReport: null,
      };
      try {
        const currentCategory = await getThreadCategoryWithManual(row.account_id, row.thread_id);
        if (!currentCategory?.isManual) {
          const category = categorizeByRules({
            labelIds: labels,
            fromAddress: row.from_address,
            listUnsubscribe: row.list_unsubscribe,
          });
          await setThreadCategory(row.account_id, row.thread_id, category, false);
        }
        await applyFiltersToMessages(row.account_id, [parsed]);
        await applySmartLabelsToMessages(row.account_id, [parsed]);
        await db.execute("DELETE FROM worker_postprocess_queue WHERE account_id = $1 AND message_id = $2", [row.account_id, row.message_id]);
        aiAccounts.add(row.account_id);
      } catch (error) {
        // Keep the item for a later app session. Rules run only with the UI open.
        console.error("Could not finish worker mail rules:", error);
        break;
      }
    }
    for (const accountId of aiAccounts) void categorizeNewThreads(accountId);
  } catch (error) {
    // The table is absent while a newly installed helper starts. A later poll
    // or app startup will retry without waking the app in the background.
    console.debug("Worker mail rules are not ready:", error);
  } finally {
    draining = false;
  }
}
