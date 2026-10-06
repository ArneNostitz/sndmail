import type { DbMessage } from "@/services/db/messages";
import { createMailLink } from "@/utils/mailLink";
import { normalizeEmail } from "@/utils/emailUtils";

/** Pick the message represented by a thread row and build its identifier-only link. */
export function createListMessageLink(
  messages: DbMessage[],
  accountId: string,
  threadId: string,
  activeLabel: string,
  ownAddresses: string[],
): string | null {
  const ordered = messages
    .filter((message) => message.account_id === accountId && message.thread_id === threadId && message.is_read_receipt !== 1)
    .sort((a, b) => b.date - a.date || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const own = new Set(ownAddresses.map(normalizeEmail));
  const target = activeLabel === "inbox"
    ? ordered.find((message) => !message.from_address || !own.has(normalizeEmail(message.from_address))) ?? ordered[0]
    : ordered[0];
  return target ? createMailLink({ accountId, threadId, messageId: target.id }) : null;
}
