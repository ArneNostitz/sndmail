import { memo, useState, useRef, useEffect, useMemo, forwardRef } from "react";
import { formatFullDate } from "@/utils/date";
import { useTimeFormat } from "@/hooks/useTimeFormat";
import { EmailRenderer, type EmailSelectionRequest } from "./EmailRenderer";
import { InlineAttachmentPreview } from "./InlineAttachmentPreview";
import { AttachmentList, useAttachmentViewer, getAttachmentsForMessage } from "./AttachmentList";
import type { DbMessage } from "@/services/db/messages";
import type { DbAttachment } from "@/services/db/attachments";
import { MailMinus, Maximize2, Minimize2 } from "lucide-react";
import { useAccountStore } from "@/stores/accountStore";
import { AuthBadge } from "./AuthBadge";
import { AuthWarningBanner } from "./AuthWarningBanner";
import { PhishingBanner } from "./PhishingBanner";
import { ReadReceiptBanner } from "./ReadReceiptBanner";
import { ReadReceiptBadge } from "./ReadReceiptBadge";
import { OneTimeCodeBanner } from "./OneTimeCodeBanner";
import { RecipientLine } from "./RecipientLine";
import type { MessageScanResult } from "@/utils/phishingDetector";
import { trimMessageBody } from "@/utils/messageTrim";
import { Tooltip } from "@/components/ui/Tooltip";

interface MessageItemProps {
  message: DbMessage;
  isLast: boolean;
  blockImages?: boolean | null;
  senderAllowlisted?: boolean;
  accountId?: string;
  threadId?: string;
  isSpam?: boolean;
  focused?: boolean;
  isSearchMatch?: boolean;
  highlightTerms?: readonly string[];
  /**
   * Lowercased addresses the user sends from, aliases included. Without it
   * this falls back to the account's own address, which misses a message sent
   * from a send-as alias.
   */
  ownAddresses?: Set<string>;
  onContextMenu?: (e: React.MouseEvent) => void;
  onSelectionContextMenu?: (request: EmailSelectionRequest) => void;
}

export const MessageItem = memo(forwardRef<HTMLDivElement, MessageItemProps>(function MessageItem({ message, isLast, blockImages, senderAllowlisted, accountId, threadId, isSpam, focused, isSearchMatch, highlightTerms, ownAddresses, onContextMenu, onSelectionContextMenu }, ref) {
  const [expanded, setExpanded] = useState(isLast || !!isSearchMatch);
  const [showFullBody, setShowFullBody] = useState(!!isSearchMatch);
  // Repaint when the 12/24-hour preference changes
  useTimeFormat();
  const [attachments, setAttachments] = useState<DbAttachment[]>([]);
  const [authBannerDismissed, setAuthBannerDismissed] = useState(false);
  const [scanResult, setScanResult] = useState<MessageScanResult | null>(null);
  const attachmentsLoadedRef = useRef(false);
  const scanStartedRef = useRef(false);

  const loadAttachments = async () => {
    if (attachmentsLoadedRef.current) return;
    attachmentsLoadedRef.current = true;
    try {
      const atts = await getAttachmentsForMessage(message.account_id, message.id);
      setAttachments(atts);
    } catch {
      // Non-critical — just show no attachments
    }
  };

  // Load attachments for initially-expanded (last) message on mount
  useEffect(() => {
    if (isLast) {
      loadAttachments();
    }
  }, [isLast]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-expand when focused via keyboard navigation
  useEffect(() => {
    if (focused && !expanded) {
      setExpanded(true);
      loadAttachments();
    }
  }, [focused]); // eslint-disable-line react-hooks/exhaustive-deps

  // A body hit must be visible when its thread opens, even when it is not the
  // newest message in the conversation.
  useEffect(() => {
    if (isSearchMatch && !expanded) {
      setExpanded(true);
      loadAttachments();
    }
  }, [isSearchMatch]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleToggle = () => {
    const willExpand = !expanded;
    setExpanded(willExpand);
    if (willExpand) {
      loadAttachments();
    }
  };

  // Scan links for phishing indicators once the message body is shown.
  // Returns null when the feature is disabled or the sender is allowlisted.
  useEffect(() => {
    if (!expanded || scanStartedRef.current) return;
    scanStartedRef.current = true;

    let cancelled = false;
    (async () => {
      try {
        const { scanMessageLinks } = await import("@/services/phishing/phishingScanner");
        const result = await scanMessageLinks(
          accountId ?? message.account_id,
          message.id,
          message.body_html,
          message.from_address,
        );
        if (!cancelled) setScanResult(result);
      } catch (err) {
        // Non-critical — the message still renders, just without link warnings
        console.error("Phishing scan failed:", err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [expanded]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleTrustSender = async () => {
    const accId = accountId ?? message.account_id;
    if (message.from_address) {
      try {
        const { addToPhishingAllowlist } = await import("@/services/db/phishingAllowlist");
        await addToPhishingAllowlist(accId, message.from_address);
      } catch (err) {
        console.error("Failed to allowlist sender:", err);
      }
    }
    setScanResult(null);
  };

  const fromDisplay = message.from_name ?? message.from_address ?? "Unknown";

  const trimmedBody = useMemo(
    () => trimMessageBody(message.body_html, message.body_text),
    [message.body_html, message.body_text],
  );
  useEffect(() => {
    if (isSearchMatch) setShowFullBody(true);
  }, [isSearchMatch]);
  const bodyHtml = showFullBody ? message.body_html : trimmedBody.html;
  const bodyText = showFullBody ? message.body_text : trimmedBody.text;
  const visibleCids = useMemo(() => {
    const cids = new Set<string>();
    const source = bodyHtml ?? "";
    const regex = /\bcid:([^"'\s)]+)/gi;
    let match;
    while ((match = regex.exec(source)) !== null) cids.add(match[1]!);
    return cids;
  }, [bodyHtml]);
  // Keep inline previews aligned with the visible body while retaining the
  // complete attachment list below it.
  const referencedCids = visibleCids;
  const { openAttachment, viewer: attachmentViewer } = useAttachmentViewer(
    message.account_id,
    attachments,
    referencedCids,
  );

  // "Opened" marker: read receipts received for a message the user sent
  const accounts = useAccountStore((s) => s.accounts);
  const accountEmail = accounts.find((a) => a.id === message.account_id)?.email;
  const from = message.from_address?.toLowerCase();
  const isOwnMessage = !from
    ? false
    : ownAddresses
      // Aliases count: mail sent as one is still the user's own
      ? ownAddresses.has(from)
      : !!accountEmail && from === accountEmail.toLowerCase();

  return (
    <div ref={ref} className={`border-b border-border-secondary last:border-b-0 ${isSpam ? "bg-red-500/8 dark:bg-red-500/10" : ""} ${focused ? "ring-2 ring-inset ring-accent/50" : ""}`} onContextMenu={onContextMenu}>
      {/* Header — always visible, click anywhere on it to expand or collapse.
          A div rather than a button: the recipient list inside has its own
          toggle, and a button cannot legally nest in a button. */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={handleToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleToggle();
          }
        }}
        className="w-full text-left px-4 py-3 cursor-pointer hover:bg-bg-hover transition-colors"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-7 h-7 rounded-full bg-accent/20 text-accent flex items-center justify-center shrink-0 text-xs font-medium">
              {fromDisplay[0]?.toUpperCase()}
            </div>
            <div className="min-w-0">
              <span className="text-sm font-medium text-text-primary truncate flex items-center gap-1">
                {fromDisplay}
                <AuthBadge authResults={message.auth_results} />
                <ReadReceiptBadge message={message} isOwnMessage={isOwnMessage} />
              </span>
              {!expanded && (
                <span className="text-xs text-text-tertiary truncate block">
                  {message.snippet}
                </span>
              )}
            </div>
          </div>
          <span className="text-xs text-text-tertiary whitespace-nowrap shrink-0 ml-2">
            {formatFullDate(message.date)}
          </span>
        </div>

        {/* Part of the header, so clicking beside it still collapses — the
            recipient list's own toggle stops the click going further */}
        {expanded && (
          <RecipientLine toAddresses={message.to_addresses} ccAddresses={message.cc_addresses} />
        )}
      </div>

      {/* Body — shown when expanded and image setting resolved */}
      {expanded && (
        <div className="px-4 pb-4">
          {!authBannerDismissed && (
            <AuthWarningBanner
              authResults={message.auth_results}
              senderAddress={message.from_address}
              onDismiss={() => setAuthBannerDismissed(true)}
            />
          )}

          {scanResult?.showBanner && (
            <PhishingBanner scanResult={scanResult} onTrustSender={handleTrustSender} />
          )}

          {!isSpam && <ReadReceiptBanner message={message} />}

          {/* A login mail's code and link as buttons — the notification
              cannot carry them, so the message does */}
          <OneTimeCodeBanner message={message} />

          {message.list_unsubscribe && (
            <UnsubscribeLink
              header={message.list_unsubscribe}
              postHeader={message.list_unsubscribe_post}
              accountId={accountId ?? message.account_id}
              threadId={threadId ?? message.thread_id}
              fromAddress={message.from_address}
              fromName={message.from_name}
            />
          )}

          {blockImages != null ? (
            <EmailRenderer
              html={bodyHtml}
              text={bodyText}
              blockImages={blockImages}
              senderAddress={message.from_address}
              accountId={message.account_id}
              senderAllowlisted={senderAllowlisted}
              messageId={message.id}
              inlineAttachments={attachments.filter((a) => a.content_id && visibleCids.has(a.content_id))}
              scanResult={scanResult}
              highlightTerms={isSearchMatch ? highlightTerms : undefined}
              onSelectionContextMenu={onSelectionContextMenu}
            />
          ) : (
            <div className="py-8 text-center text-text-tertiary text-sm">Loading...</div>
          )}

          {trimmedBody.trimmed && (
            <Tooltip content={showFullBody ? "Hide quotes and signature again" : "Show the full message including quotes and signature"}>
              <button
                type="button"
                onClick={() => setShowFullBody((current) => !current)}
                className="mt-2 inline-flex items-center gap-1 text-xs text-accent hover:underline"
              >
                {showFullBody ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
                {showFullBody ? "Hide quoted text" : "View full message"}
              </button>
            </Tooltip>
          )}

          <InlineAttachmentPreview
            accountId={message.account_id}
            messageId={message.id}
            attachments={attachments}
            referencedCids={referencedCids}
            onAttachmentClick={openAttachment}
          />

          <AttachmentList
            accountId={message.account_id}
            messageId={message.id}
            attachments={attachments}
            referencedCids={referencedCids}
            onOpenAttachment={openAttachment}
          />

          {attachmentViewer}
        </div>
      )}
    </div>
  );
}));

export function parseUnsubscribeUrl(header: string): string | null {
  // Prefer https URL over mailto
  const httpMatch = header.match(/<(https?:\/\/[^>]+)>/);
  if (httpMatch?.[1]) return httpMatch[1];
  const mailtoMatch = header.match(/<(mailto:[^>]+)>/);
  if (mailtoMatch?.[1]) return mailtoMatch[1];
  return null;
}

function UnsubscribeLink({
  header,
  postHeader,
  accountId,
  threadId,
  fromAddress,
  fromName,
}: {
  header: string;
  postHeader?: string | null;
  accountId: string;
  threadId: string;
  fromAddress: string | null;
  fromName: string | null;
}) {
  const url = parseUnsubscribeUrl(header);
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "failed">("idle");
  if (!url) return null;

  const handleClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setStatus("loading");
    try {
      const { executeUnsubscribe } = await import("@/services/unsubscribe/unsubscribeManager");
      const result = await executeUnsubscribe(
        accountId,
        threadId,
        fromAddress ?? "unknown",
        fromName,
        header,
        postHeader ?? null,
      );
      setStatus(result.success ? "done" : "failed");
    } catch (err) {
      console.error("Failed to unsubscribe:", err);
      setStatus("failed");
    }
  };

  return (
    <button
      onClick={handleClick}
      disabled={status === "loading" || status === "done"}
      className={`flex items-center gap-1 text-xs mb-2 transition-colors ${
        status === "done"
          ? "text-success"
          : status === "failed"
            ? "text-danger"
            : "text-text-tertiary hover:text-text-secondary"
      }`}
    >
      <MailMinus size={12} />
      {status === "loading" && "Unsubscribing..."}
      {status === "done" && "Unsubscribed"}
      {status === "failed" && "Unsubscribe failed — click to retry"}
      {status === "idle" && "Unsubscribe"}
    </button>
  );
}
