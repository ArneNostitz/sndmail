export interface MailLinkTarget {
  accountId: string;
  threadId: string;
  messageId?: string;
}

const SUPPORTED_MAIL_LINK_PROTOCOLS = new Set(["sndmail:", "velo:"]);

function validId(value: string | null): value is string {
  return !!value && value.length <= 2048 && !/[\u0000-\u001f\u007f]/.test(value) && value.trim() === value;
}

/** A public app link contains identifiers only, never mail content or credentials. */
export function createMailLink(target: MailLinkTarget): string {
  if (!validId(target.accountId) || !validId(target.threadId) ||
    (target.messageId !== undefined && !validId(target.messageId))) {
    throw new Error("Invalid mail identifiers.");
  }
  const query = new URLSearchParams({ account: target.accountId, thread: target.threadId });
  if (target.messageId) query.set("message", target.messageId);
  return `sndmail://open?${query}`;
}

export function parseMailLink(value: string): MailLinkTarget {
  if (value.length > 16000) throw new Error("Mail link is too long.");
  const url = new URL(value);
  if (!SUPPORTED_MAIL_LINK_PROTOCOLS.has(url.protocol) || url.hostname !== "open" || url.username || url.password || url.port ||
    (url.pathname !== "" && url.pathname !== "/") || url.hash) throw new Error("Invalid mail link.");
  for (const key of url.searchParams.keys()) {
    if (!["account", "thread", "message"].includes(key) || url.searchParams.getAll(key).length !== 1) {
      throw new Error("Invalid mail link parameters.");
    }
  }
  const accountId = url.searchParams.get("account");
  const threadId = url.searchParams.get("thread");
  const messageId = url.searchParams.get("message");
  if (!validId(accountId) || !validId(threadId) || (messageId !== null && !validId(messageId))) {
    throw new Error("Mail link needs valid account and thread identifiers.");
  }
  return { accountId, threadId, ...(messageId === null ? {} : { messageId }) };
}
