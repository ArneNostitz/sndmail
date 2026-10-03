import { CheckCheck, Hourglass } from "lucide-react";
import { formatFullDate } from "@/utils/date";
import type { DbMessage } from "@/services/db/messages";

import { Tooltip } from "@/components/ui/Tooltip";
interface ReadReceiptBadgeProps {
  message: DbMessage;
  /** Only the user's own mail can be waiting on, or have received, a receipt. */
  isOwnMessage: boolean;
}

/**
 * Where a message stands with its read receipt, as a mark on the header.
 *
 * A receipt is an answer about a message the user already has, so it belongs
 * here rather than arriving as another mail in the inbox: an hourglass while
 * one was asked for and none has come back, a double check once it has.
 * Nothing at all when no receipt was requested.
 */
export function ReadReceiptBadge({ message, isOwnMessage }: ReadReceiptBadgeProps) {
  if (!isOwnMessage) return null;

  const count = message.read_receipt_count ?? 0;
  if (count > 0) {
    return (
      <Tooltip content={`Read receipt received${
          message.read_receipt_last_at ? ` — last ${formatFullDate(message.read_receipt_last_at)}` : ""
        }`}><span
        className="inline-flex items-center gap-0.5 text-[0.625rem] px-1.5 py-px rounded-full bg-success/15 text-success shrink-0"

      >
        <CheckCheck size={10} />
        {count > 1 ? `Opened ${count}×` : "Opened"}
      </span></Tooltip>
    );
  }

  const requested = !!message.disposition_notification_to;
  if (!requested) return null;

  return (
    <Tooltip content="A read receipt was requested — nothing back yet. Many clients never answer."><span
      className="inline-flex items-center gap-0.5 text-[0.625rem] px-1.5 py-px rounded-full bg-bg-tertiary text-text-tertiary shrink-0"

    >
      <Hourglass size={10} />
      Awaiting
    </span></Tooltip>
  );
}
