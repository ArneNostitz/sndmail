import type { GmailMessage, GmailMessagePart, GmailHeader } from "./client";
import { parseAuthenticationResults } from "./authParser";

export interface ParsedAttachment {
  filename: string;
  mimeType: string;
  size: number;
  gmailAttachmentId: string;
  contentId: string | null;
  isInline: boolean;
}

export interface ParsedMessage {
  id: string;
  threadId: string;
  fromAddress: string | null;
  fromName: string | null;
  toAddresses: string | null;
  ccAddresses: string | null;
  bccAddresses: string | null;
  replyTo: string | null;
  subject: string | null;
  snippet: string;
  date: number;
  isRead: boolean;
  isStarred: boolean;
  bodyHtml: string | null;
  bodyText: string | null;
  rawSize: number;
  internalDate: number;
  labelIds: string[];
  hasAttachments: boolean;
  attachments: ParsedAttachment[];
  listUnsubscribe: string | null;
  listUnsubscribePost: string | null;
  authResults: string | null;
  messageIdHeader: string | null;
  /**
   * Threading headers. Gmail groups mail into its own threads, but these are
   * what lets snd relate messages Gmail split — a ticket system replying
   * under a new subject, say — and they are the only link an IMAP account has.
   */
  inReplyToHeader: string | null;
  referencesHeader: string | null;
  dispositionNotificationTo: string | null;
  /** Raw text of a message/disposition-notification part, when this message is an MDN. */
  mdnReport: string | null;
}

export function parseGmailMessage(msg: GmailMessage): ParsedMessage {
  const headers = msg.payload.headers;
  const from = getHeader(headers, "From");
  const { name: fromName, address: fromAddress } = parseEmailAddress(from);

  const bodyHtml = extractBody(msg.payload, "text/html");
  const bodyText = extractBody(msg.payload, "text/plain");
  const attachments = extractAttachments(msg.payload);
  const authResult = parseAuthenticationResults(headers);

  return {
    id: msg.id,
    threadId: msg.threadId,
    fromAddress: fromAddress,
    fromName: fromName,
    toAddresses: getHeader(headers, "To"),
    ccAddresses: getHeader(headers, "Cc"),
    bccAddresses: getHeader(headers, "Bcc"),
    replyTo: getHeader(headers, "Reply-To"),
    subject: getHeader(headers, "Subject"),
    snippet: msg.snippet,
    date: parseInt(msg.internalDate, 10),
    isRead: !msg.labelIds.includes("UNREAD"),
    isStarred: msg.labelIds.includes("STARRED"),
    bodyHtml,
    bodyText,
    rawSize: msg.sizeEstimate,
    internalDate: parseInt(msg.internalDate, 10),
    labelIds: msg.labelIds,
    hasAttachments: attachments.length > 0,
    attachments,
    listUnsubscribe: getHeader(headers, "List-Unsubscribe"),
    listUnsubscribePost: getHeader(headers, "List-Unsubscribe-Post"),
    authResults: authResult ? JSON.stringify(authResult) : null,
    messageIdHeader: getHeader(headers, "Message-ID"),
    inReplyToHeader: getHeader(headers, "In-Reply-To"),
    referencesHeader: getHeader(headers, "References"),
    dispositionNotificationTo: getHeader(headers, "Disposition-Notification-To"),
    mdnReport: extractMdnReport(msg.payload),
  };
}

function getHeader(headers: GmailHeader[], name: string): string | null {
  const header = headers.find(
    (h) => h.name.toLowerCase() === name.toLowerCase(),
  );
  return header?.value ?? null;
}

function parseEmailAddress(raw: string | null): {
  name: string | null;
  address: string | null;
} {
  if (!raw) return { name: null, address: null };

  // Format: "Display Name <email@example.com>"
  const angleMatch = raw.match(/^"?([^"<]*)"?\s*<([^>]+)>$/);
  if (angleMatch) {
    const name = angleMatch[1]?.trim() || null;
    const address = angleMatch[2]?.trim() || null;
    return { name: name === address ? null : name, address };
  }

  // Bare email: "email@example.com"
  return { name: null, address: raw.trim() };
}

/**
 * Find the machine-readable part of an incoming read receipt
 * (message/disposition-notification inside a multipart/report).
 */
function extractMdnReport(part: GmailMessagePart): string | null {
  if (part.mimeType.toLowerCase() === "message/disposition-notification") {
    // Gmail may expose this small machine-readable part through attachmentId
    // instead of inline data. An empty string still records that this is an
    // MDN, allowing sync to hide it and correlate via In-Reply-To/fallback.
    return part.body.data ? decodeBase64Url(part.body.data) : "";
  }
  if (part.parts) {
    for (const child of part.parts) {
      const result = extractMdnReport(child);
      if (result !== null) return result;
    }
  }
  return null;
}

function extractBody(
  part: GmailMessagePart,
  mimeType: string,
): string | null {
  if (part.mimeType === mimeType && part.body.data) {
    const contentType = part.headers?.find(
      (header) => header.name.toLowerCase() === "content-type",
    )?.value;
    const charset = contentType?.match(/charset\s*=\s*["']?([^\s;"']+)/i)?.[1];
    return decodeBase64Url(part.body.data, charset);
  }

  if (part.parts) {
    for (const child of part.parts) {
      const result = extractBody(child, mimeType);
      if (result) return result;
    }
  }

  return null;
}

function extractAttachments(part: GmailMessagePart): ParsedAttachment[] {
  const results: ParsedAttachment[] = [];
  collectAttachments(part, results);
  return results;
}

function collectAttachments(part: GmailMessagePart, results: ParsedAttachment[]): void {
  if (part.body.attachmentId) {
    const contentIdHeader = part.headers?.find(
      (h) => h.name.toLowerCase() === "content-id",
    );
    const contentDisposition = part.headers?.find(
      (h) => h.name.toLowerCase() === "content-disposition",
    );
    const hasFilename = part.filename && part.filename.length > 0;
    const hasCid = !!contentIdHeader?.value;
    const isInline = contentDisposition?.value?.toLowerCase().startsWith("inline") ?? false;

    // Collect parts with a filename (regular attachments) or a Content-ID (CID inline images)
    if (hasFilename || hasCid) {
      results.push({
        filename: part.filename || contentIdHeader?.value?.replace(/[<>]/g, "") || "inline",
        mimeType: part.mimeType,
        size: part.body.size,
        gmailAttachmentId: part.body.attachmentId,
        contentId: contentIdHeader?.value?.replace(/[<>]/g, "") ?? null,
        isInline: isInline && !hasFilename,
      });
    }
  }

  if (part.parts) {
    for (const child of part.parts) {
      collectAttachments(child, results);
    }
  }
}

function decodeBase64Url(data: string, declaredCharset?: string): string {
  // Gmail uses URL-safe base64
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));

  if (declaredCharset) {
    try {
      return new TextDecoder(declaredCharset).decode(bytes);
    } catch {
      // Unknown/misspelled charset: continue with safe fallbacks below.
    }
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // A missing charset on older European mail commonly means Windows-1252.
    return new TextDecoder("windows-1252").decode(bytes);
  }
}
