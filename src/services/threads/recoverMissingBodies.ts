import type { DbMessage } from "../db/messages";
import { updateMissingMessageBody } from "../db/messages";
import { getEmailProvider } from "../email/providerFactory";

/** Fetch and cache bodies only for messages in the currently opened thread. */
export async function recoverMissingBodies(
  accountId: string,
  messages: DbMessage[],
): Promise<boolean> {
  const missing = messages.filter((message) => !message.body_html && !message.body_text);
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
      if (!fetched.bodyHtml && !fetched.bodyText) continue;
      await updateMissingMessageBody(accountId, message.id, fetched.bodyHtml, fetched.bodyText);
      recovered = true;
    } catch (error) {
      // One unavailable message should not prevent recovery of the rest.
      console.warn(`Could not recover body for message ${message.id}:`, error);
    }
  }
  return recovered;
}
