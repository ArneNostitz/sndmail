import type { DbMessage } from "../db/messages";
import { updateMissingMessageBody } from "../db/messages";
import { getEmailProvider } from "../email/providerFactory";

// Plain-text-only mail legitimately has no HTML part. Remember successful
// fetches for this process so reopening those threads does not refetch forever.
const checkedForHtml = new Set<string>();

/** Fetch and cache bodies only for messages in the currently opened thread. */
export async function recoverMissingBodies(
  accountId: string,
  messages: DbMessage[],
): Promise<boolean> {
  const missing = messages.filter(
    (message) => !message.body_html && !checkedForHtml.has(`${accountId}:${message.id}`),
  );
  if (missing.length === 0) return false;

  let provider;
  try {
    provider = await getEmailProvider(accountId);
  } catch (error) {
    console.warn(`Could not create provider while recovering bodies for ${accountId}:`, error);
    return false;
  }
  let recovered = false;
  for (const message of missing) {
    try {
      const fetched = await provider.fetchMessage(message.id);
      checkedForHtml.add(`${accountId}:${message.id}`);
      if (fetched.bodyHtml || (!message.body_text && fetched.bodyText)) {
        await updateMissingMessageBody(accountId, message.id, fetched.bodyHtml, fetched.bodyText);
        recovered = true;
      }
    } catch (error) {
      // One unavailable message should not prevent recovery of the rest.
      console.warn(`Could not recover body for message ${message.id}:`, error);
    }
  }
  return recovered;
}
