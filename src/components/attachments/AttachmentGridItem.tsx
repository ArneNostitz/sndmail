import { Download, Eye, ExternalLink } from "lucide-react";
import { formatFileSize, getFileIcon, canPreview } from "@/utils/fileTypeHelpers";
import type { AttachmentWithContext } from "@/services/db/attachments";

import { Tooltip } from "@/components/ui/Tooltip";
interface AttachmentGridItemProps {
  attachment: AttachmentWithContext;
  onPreview: () => void;
  onDownload: () => void;
  onJumpToEmail: () => void;
}

function formatRelativeDate(timestamp: number | null): string {
  if (!timestamp) return "";
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export function AttachmentGridItem({ attachment, onPreview, onDownload, onJumpToEmail }: AttachmentGridItemProps) {
  const previewable = canPreview(attachment.mime_type, attachment.filename);
  const senderName = attachment.from_name || attachment.from_address || "Unknown";

  return (
    <div className="group relative flex flex-col border border-border-primary rounded-lg hover:border-border-secondary hover:bg-bg-hover transition-colors overflow-hidden">
      {/* Icon area */}
      <button
        onClick={previewable ? onPreview : onDownload}
        className="flex items-center justify-center h-24 bg-bg-secondary text-3xl"
      >
        {getFileIcon(attachment.mime_type)}
      </button>

      {/* Info */}
      <div className="px-3 py-2 flex flex-col gap-0.5 min-w-0">
        <Tooltip content={attachment.filename ?? undefined}><span className="text-xs font-medium text-text-primary truncate" >
          {attachment.filename ?? "Unnamed"}
        </span></Tooltip>
        <Tooltip content={senderName}><span className="text-[0.6875rem] text-text-tertiary truncate" >
          {senderName}
        </span></Tooltip>
        <div className="flex items-center gap-2 text-[0.6875rem] text-text-tertiary">
          {attachment.size != null && <span>{formatFileSize(attachment.size)}</span>}
          {attachment.date && <span>{formatRelativeDate(attachment.date)}</span>}
        </div>
      </div>

      {/* Hover actions */}
      <div className="absolute top-1.5 right-1.5 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        {previewable && (
          <Tooltip content="Preview"><button
            onClick={onPreview}
            className="p-1.5 rounded-md bg-bg-primary/90 border border-border-primary text-text-secondary hover:text-text-primary transition-colors"

          >
            <Eye size={13} />
          </button></Tooltip>
        )}
        <Tooltip content="Download"><button
          onClick={onDownload}
          className="p-1.5 rounded-md bg-bg-primary/90 border border-border-primary text-text-secondary hover:text-text-primary transition-colors"

        >
          <Download size={13} />
        </button></Tooltip>
        <Tooltip content="Jump to email"><button
          onClick={onJumpToEmail}
          className="p-1.5 rounded-md bg-bg-primary/90 border border-border-primary text-text-secondary hover:text-text-primary transition-colors"

        >
          <ExternalLink size={13} />
        </button></Tooltip>
      </div>
    </div>
  );
}
