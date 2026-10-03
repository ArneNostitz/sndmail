import { memo, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Maximize2, Minimize2 } from "lucide-react";
import { formatFullDate } from "@/utils/date";
import { useTimeFormat } from "@/hooks/useTimeFormat";
import { trimMessageBody, previewText } from "@/utils/messageTrim";
import { EmailRenderer, type EmailSelectionRequest } from "./EmailRenderer";
import { InlineAttachmentPreview } from "./InlineAttachmentPreview";
import { AttachmentList, useAttachmentViewer, getAttachmentsForMessage } from "./AttachmentList";
import { SenderAvatar } from "./SenderAvatar";
import { AuthBadge } from "./AuthBadge";
import { ReadReceiptBadge } from "./ReadReceiptBadge";
import { OneTimeCodeBanner } from "./OneTimeCodeBanner";
import type { DbMessage } from "@/services/db/messages";
import type { DbAttachment } from "@/services/db/attachments";

import { Tooltip } from "@/components/ui/Tooltip";
interface ChatMessageProps {
  message: DbMessage;
  /** Written by the user — accent rule on the left, gutter on that side. */
  isMine: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
  blockImages?: boolean | null;
  senderAllowlisted?: boolean;
  isSpam?: boolean;
  isSearchMatch?: boolean;
  highlightTerms?: readonly string[];
  onContextMenu?: (e: React.MouseEvent) => void;
  onSelectionContextMenu?: (request: EmailSelectionRequest) => void;
}

/**
 * One message in the conversation view.
 *
 * Still an email, laid out at the full width of the pane — who wrote it is
 * said by a rule down one edge and a 25px gutter on that side, not by
 * squeezing the text into a column. The body is trimmed to what the sender
 * actually typed: the mail they quoted is the message above and their
 * signature is in the header, so repeating both turns a conversation into a
 * wall. "View full" puts the original back for the message that needs it.
 */
export const ChatMessage = memo(function ChatMessage({
  message,
  isMine,
  collapsed,
  onToggleCollapse,
  blockImages,
  senderAllowlisted,
  isSpam,
  isSearchMatch,
  highlightTerms,
  onContextMenu,
  onSelectionContextMenu,
}: ChatMessageProps) {
  useTimeFormat();
  const [showFull, setShowFull] = useState(!!isSearchMatch);
  const [attachments, setAttachments] = useState<DbAttachment[]>([]);
  const attachmentsLoadedRef = useRef(false);

  useEffect(() => {
    if (isSearchMatch) setShowFull(true);
  }, [isSearchMatch]);

  useEffect(() => {
    if (collapsed || attachmentsLoadedRef.current) return;
    attachmentsLoadedRef.current = true;
    getAttachmentsForMessage(message.account_id, message.id)
      .then(setAttachments)
      .catch(() => {
        // Non-critical — the message still renders, just without attachments
      });
  }, [collapsed, message.account_id, message.id]);

  const trimmed = useMemo(
    () => trimMessageBody(message.body_html, message.body_text),
    [message.body_html, message.body_text],
  );

  const referencedCids = useMemo(() => {
    const cids = new Set<string>();
    const source = showFull ? message.body_html : trimmed.html;
    if (!source) return cids;
    const regex = /\bcid:([^"'\s)]+)/gi;
    let m;
    while ((m = regex.exec(source)) !== null) {
      cids.add(m[1]!);
    }
    return cids;
  }, [showFull, message.body_html, trimmed.html]);

  const { openAttachment, viewer: attachmentViewer } = useAttachmentViewer(
    message.account_id,
    attachments,
    referencedCids,
  );

  const fromDisplay = message.from_name ?? message.from_address ?? "Unknown";
  const bodyHtml = showFull ? message.body_html : trimmed.html;
  const bodyText = showFull ? message.body_text : trimmed.text;

  // A message that is nothing but the mail it quotes — a bare forward, or a
  // reply whose only content was the quote. Showing the quoted newsletter
  // here would bury the conversation; "View full" still has it.
  const forwardOnly = trimmed.empty && trimmed.trimmed;
  // The stored snippet comes from the untrimmed mail, so a folded message
  // would otherwise preview the very quote the trim removed
  const preview = forwardOnly
    ? "Forwarded an email"
    : previewText(trimmed) || message.snippet || "(No message)";

  return (
    <div
      className={`border-b border-border-secondary last:border-b-0 py-3 pl-4 pr-4 ${
        // The message keeps the full width of the pane — only a 25px gutter and
        // a rule down one edge say who wrote it, so nothing gets squeezed into
        // a column the way a chat bubble would
        isMine
          ? "ml-[25px] border-l-2 border-l-accent"
          : "mr-[25px] border-r-2 border-r-border-primary"
      } ${isSpam ? "bg-red-500/8 dark:bg-red-500/10" : isMine ? "bg-accent-light/40" : ""}`}
      onContextMenu={onContextMenu}
      data-message-id={message.id}
    >
      {/* Who and when, bundled into one line, turned towards the sender's side */}
      <div className={`flex items-center gap-2 mb-2 ${isMine ? "flex-row-reverse" : ""}`}>
        <SenderAvatar
          email={message.from_address}
          name={message.from_name}
          className="w-6 h-6 text-[0.625rem] shrink-0"
        />
        <div className={`flex items-baseline gap-1.5 min-w-0 flex-1 ${isMine ? "flex-row-reverse" : ""}`}>
          <span className="text-xs font-medium text-text-primary truncate">
            {isMine ? "You" : fromDisplay}
          </span>
          <span className="text-[0.625rem] text-text-tertiary whitespace-nowrap">
            {formatFullDate(message.date)}
          </span>
          <AuthBadge authResults={message.auth_results} />
          <ReadReceiptBadge message={message} isOwnMessage={isMine} />
        </div>
      </div>

      {collapsed ? (
        <button
          onClick={onToggleCollapse}
          className="w-full flex items-center gap-1 text-left text-xs text-text-tertiary hover:text-text-secondary transition-colors"
        >
          <ChevronRight size={12} className="shrink-0" />
          <span className={`truncate ${forwardOnly ? "italic" : ""}`}>{preview}</span>
        </button>
      ) : (
        <>
          <OneTimeCodeBanner message={message} />
          {forwardOnly && !showFull ? (
            // Attachments still render below — a forward usually carries them
            <div className="text-sm text-text-tertiary italic">Forwarded an email</div>
          ) : blockImages != null ? (
            <EmailRenderer
              html={bodyHtml}
              text={bodyText}
              blockImages={blockImages}
              senderAddress={message.from_address}
              accountId={message.account_id}
              senderAllowlisted={senderAllowlisted}
              messageId={message.id}
              inlineAttachments={attachments.filter((a) => a.content_id)}
              highlightTerms={isSearchMatch ? highlightTerms : undefined}
              onSelectionContextMenu={onSelectionContextMenu}
            />
          ) : (
            <div className="py-4 text-center text-text-tertiary text-xs">Loading...</div>
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
        </>
      )}

      {/* Controls sit under the message so they never crowd the text */}
      {!collapsed && (
        <div className={`flex items-center gap-2 mt-2 ${isMine ? "flex-row-reverse" : ""}`}>
          <Tooltip content="Collapse this message"><button
            onClick={onToggleCollapse}
            className="flex items-center gap-0.5 text-[0.625rem] text-text-tertiary hover:text-text-secondary transition-colors"

          >
            <ChevronDown size={11} />
            Collapse
          </button></Tooltip>
          {(trimmed.trimmed || showFull) && (
            <Tooltip content={showFull ? "Hide quotes and signature again" : "Show the original mail with quotes and signature"}><button
              onClick={() => setShowFull((v) => !v)}
              className="flex items-center gap-0.5 text-[0.625rem] text-accent hover:underline"

            >
              {showFull ? <Minimize2 size={11} /> : <Maximize2 size={11} />}
              {showFull ? "View trimmed" : "View full"}
            </button></Tooltip>
          )}
        </div>
      )}
    </div>
  );
});
