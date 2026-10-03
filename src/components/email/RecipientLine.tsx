import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { extractEmailAddresses } from "@/utils/emailUtils";

import { Tooltip } from "@/components/ui/Tooltip";
/** Recipients shown before the line folds into "+N more". */
const PREVIEW_COUNT = 3;

interface RecipientLineProps {
  toAddresses: string | null;
  ccAddresses?: string | null;
}

/**
 * Who a message went to, folded by default.
 *
 * A mail to a few hundred people puts a wall of addresses between the header
 * and the first line of text, and it was previously tied to the body's own
 * expand state — the only way to get rid of it was to close the message. This
 * folds on its own, so a long recipient list costs one line until asked for.
 */
export function RecipientLine({ toAddresses, ccAddresses }: RecipientLineProps) {
  const [expanded, setExpanded] = useState(false);

  const to = useMemo(() => extractEmailAddresses(toAddresses), [toAddresses]);
  const cc = useMemo(() => extractEmailAddresses(ccAddresses ?? null), [ccAddresses]);

  if (to.length === 0 && cc.length === 0) return null;

  const total = to.length + cc.length;
  const foldable = total > PREVIEW_COUNT;

  if (!foldable) {
    return (
      <div className="mt-1 text-xs text-text-tertiary break-words">
        {to.length > 0 && <span>To: {to.join(", ")}</span>}
        {cc.length > 0 && <span>{to.length > 0 ? " · " : ""}Cc: {cc.join(", ")}</span>}
      </div>
    );
  }

  if (!expanded) {
    const shown = to.length > 0 ? to.slice(0, PREVIEW_COUNT) : cc.slice(0, PREVIEW_COUNT);
    const hidden = total - shown.length;
    return (
      <Tooltip content="Show every recipient"><button
        onClick={(e) => { e.stopPropagation(); setExpanded(true); }}
        className="mt-1 flex items-start gap-1 text-xs text-text-tertiary hover:text-text-secondary transition-colors text-left w-full"

      >
        <ChevronRight size={11} className="shrink-0 mt-0.5" />
        <span className="truncate">
          To: {shown.join(", ")}
          <span className="text-text-tertiary"> +{hidden} more</span>
        </span>
      </button></Tooltip>
    );
  }

  return (
    <div className="mt-1 text-xs text-text-tertiary">
      <Tooltip content="Hide the recipient list"><button
        onClick={(e) => { e.stopPropagation(); setExpanded(false); }}
        className="flex items-center gap-1 hover:text-text-secondary transition-colors"

      >
        <ChevronDown size={11} className="shrink-0" />
        {total} recipient{total === 1 ? "" : "s"}
      </button></Tooltip>
      {/* Capped and scrollable: a few hundred addresses must not push the
          message itself off the screen */}
      <div onClick={(e) => e.stopPropagation()} className="mt-1 pl-4 max-h-40 overflow-y-auto break-words select-text">
        {to.length > 0 && <div>To: {to.join(", ")}</div>}
        {cc.length > 0 && <div className="mt-1">Cc: {cc.join(", ")}</div>}
      </div>
    </div>
  );
}
