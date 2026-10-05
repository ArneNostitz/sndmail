import { extractEmailAddresses, normalizeEmail } from "@/utils/emailUtils";

export interface ReplyMessage {
  from_address: string | null;
  reply_to?: string | null;
  to_addresses?: string | null;
  cc_addresses?: string | null;
}

export interface ReplyRecipients {
  to: string[];
  cc: string[];
}

function isOwnAddress(header: string | null | undefined, own: Set<string>): boolean {
  return extractEmailAddresses(header).some((address) => own.has(address));
}

/** Find the latest correspondent's message, even when the user sent last. */
export function latestIncomingMessage<T extends ReplyMessage>(
  messages: T[],
  ownAddresses: Iterable<string>,
): T | undefined {
  const own = new Set([...ownAddresses].map(normalizeEmail));
  return [...messages].reverse().find((message) =>
    message.from_address && !isOwnAddress(message.from_address, own),
  );
}

/** Resolve Reply and Reply All recipients against the latest incoming message. */
export function resolveReplyRecipients(
  message: ReplyMessage,
  mode: "reply" | "replyAll",
  ownAddresses: Iterable<string>,
): ReplyRecipients {
  const own = new Set([...ownAddresses].map(normalizeEmail));
  const replyTo = message.reply_to || message.from_address;
  if (mode === "reply") {
    const addresses = extractEmailAddresses(replyTo);
    return { to: addresses.length > 0 ? addresses : [], cc: [] };
  }

  const to = new Set<string>();
  const cc = new Set<string>();
  const add = (set: Set<string>, value: string | null | undefined) => {
    if (!value) return;
    for (const address of extractEmailAddresses(value)) {
      if (!own.has(normalizeEmail(address))) set.add(address);
    }
  };
  add(to, replyTo);
  add(to, message.to_addresses);
  add(cc, message.cc_addresses);
  for (const address of to) cc.delete(address);
  return { to: [...to], cc: [...cc] };
}
