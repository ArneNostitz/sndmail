import { useState, useCallback, useRef, useEffect } from "react";
import { getAttachmentsForMessage, type DbAttachment } from "@/services/db/attachments";
import {
  fetchAttachmentBytes,
  saveAttachmentSmart,
  quickLookAttachments,
  type AttachmentRef,
} from "@/services/attachments/attachmentActions";
import { Modal } from "@/components/ui/Modal";
import { Download, Eye, Check, ChevronLeft, ChevronRight } from "lucide-react";
import { formatFileSize, isImage, isPdf, isText, canPreview, getFileIcon } from "@/utils/fileTypeHelpers";

import { Tooltip } from "@/components/ui/Tooltip";
export function attachmentRef(accountId: string, att: DbAttachment): AttachmentRef {
  return {
    accountId,
    messageId: att.message_id,
    gmailAttachmentId: att.gmail_attachment_id!,
    filename: att.filename,
  };
}

/**
 * Small per-attachment save button: plain click saves into the Downloads
 * folder, ⌘/Ctrl-click asks for a folder. Shared by every attachment surface.
 */
export function AttachmentSaveButton({
  accountId,
  attachment,
  size = 12,
  className = "",
}: {
  accountId: string;
  attachment: DbAttachment;
  size?: number;
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const resetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (resetRef.current) clearTimeout(resetRef.current); }, []);

  const handleSave = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (state === "saving" || !attachment.gmail_attachment_id) return;
    setState("saving");
    try {
      const path = await saveAttachmentSmart(attachmentRef(accountId, attachment), e);
      setState(path ? "saved" : "idle");
    } catch (err) {
      console.error("Failed to save attachment:", err);
      setState("failed");
    }
    resetRef.current = setTimeout(() => setState("idle"), 2000);
  };

  return (
    <Tooltip content="Save to Downloads — ⌘-click to choose a folder"><button
      onClick={handleSave}
      disabled={!attachment.gmail_attachment_id}

      className={`shrink-0 transition-colors disabled:opacity-40 ${
        state === "saved"
          ? "text-success"
          : state === "failed"
            ? "text-danger"
            : "text-text-tertiary hover:text-accent"
      } ${className}`}
    >
      {state === "saved" ? (
        <Check size={size} />
      ) : (
        <Download size={size} className={state === "saving" ? "animate-pulse" : ""} />
      )}
    </button></Tooltip>
  );
}

/**
 * The attachments a message actually shows: CID images rendered in the body
 * and true inline parts are dropped, then duplicates (name+size) collapse.
 */
export function visibleAttachments(
  attachments: DbAttachment[],
  referencedCids?: Set<string>,
): DbAttachment[] {
  const seen = new Set<string>();
  return attachments.filter((a) => {
    // Skip attachments whose CID is referenced in the email body (already rendered inline)
    if (a.content_id && referencedCids?.has(a.content_id)) return false;
    // True inline: marked inline with no filename
    if (a.is_inline && !a.filename) return false;
    const key = `${a.filename}:${a.size}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * One opener for all attachments of a message: Quick Look on macOS with the
 * whole set (its ←/→ arrows shuffle through them), the in-app preview with
 * the same navigation everywhere else. `openAttachment` works for both the
 * attachment chips and the inline image/PDF previews, so a message needs a
 * single viewer instance.
 */
export function useAttachmentViewer(
  accountId: string,
  attachments: DbAttachment[],
  referencedCids?: Set<string>,
) {
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);

  const fileAttachments = visibleAttachments(attachments, referencedCids);
  const openable = fileAttachments.filter((a) => a.gmail_attachment_id);

  const openAttachment = async (att: DbAttachment) => {
    const idx = openable.findIndex((a) => a.id === att.id);
    if (idx < 0) return;
    try {
      if (await quickLookAttachments(openable.map((a) => attachmentRef(accountId, a)), idx)) {
        return;
      }
    } catch (err) {
      console.error("Failed to open attachment:", err);
    }
    setPreviewIndex(idx);
  };

  const viewer =
    previewIndex !== null && openable.length > 0 ? (
      <AttachmentPreview
        attachments={openable}
        startIndex={previewIndex}
        onClose={() => setPreviewIndex(null)}
      />
    ) : null;

  return { fileAttachments, openAttachment, viewer };
}

interface AttachmentListProps {
  accountId: string;
  messageId: string;
  attachments: DbAttachment[];
  referencedCids?: Set<string>;
  /** When set, opening is delegated (the caller renders the shared viewer). */
  onOpenAttachment?: (att: DbAttachment) => void;
}

export function AttachmentList({ accountId, attachments, referencedCids, onOpenAttachment }: AttachmentListProps) {
  const ownViewer = useAttachmentViewer(accountId, attachments, referencedCids);
  const fileAttachments = ownViewer.fileAttachments;
  const handleOpen = onOpenAttachment ?? ownViewer.openAttachment;

  if (fileAttachments.length === 0) return null;

  return (
    <>
      <div className="mt-3 pt-3 border-t border-border-secondary">
        <div className="text-xs text-text-tertiary mb-2">
          {fileAttachments.length} attachment{fileAttachments.length !== 1 ? "s" : ""}
        </div>
        <div className="flex flex-wrap gap-2">
          {fileAttachments.map((att) => (
            <div
              key={att.id}
              className="flex items-center text-xs rounded-md border border-border-primary overflow-hidden"
            >
              <Tooltip content="Preview"><button
                onClick={() => handleOpen(att)}

                className="flex items-center gap-2 px-3 py-1.5 hover:bg-bg-hover transition-colors"
              >
                <span className="text-text-tertiary">{getFileIcon(att.mime_type)}</span>
                <span className="text-text-secondary truncate max-w-[200px]">
                  {att.filename ?? "Unnamed"}
                </span>
                {att.size != null && (
                  <span className="text-text-tertiary whitespace-nowrap">
                    {formatFileSize(att.size)}
                  </span>
                )}
              </button></Tooltip>
              <AttachmentSaveButton
                accountId={accountId}
                attachment={att}
                size={13}
                className="px-2 py-1.5 border-l border-border-secondary hover:bg-bg-hover"
              />
            </div>
          ))}
        </div>
      </div>

      {!onOpenAttachment && ownViewer.viewer}
    </>
  );
}

/**
 * In-app preview over a set of attachments — ←/→ (keys or buttons) shuffle
 * through the set, mirroring what Quick Look does on macOS.
 */
export function AttachmentPreview({
  attachments,
  startIndex = 0,
  onClose,
}: {
  attachments: DbAttachment[];
  startIndex?: number;
  onClose: () => void;
}) {
  const clamp = (i: number) => Math.min(Math.max(i, 0), attachments.length - 1);
  const [index, setIndex] = useState(() => clamp(startIndex));
  const [saving, setSaving] = useState(false);
  const attachment = attachments[clamp(index)]!;

  const goTo = useCallback(
    (delta: number) => {
      setIndex((i) => Math.min(Math.max(i + delta, 0), attachments.length - 1));
    },
    [attachments.length],
  );

  // ←/→ move through the set. Capture phase, so message/thread navigation
  // behind the modal never sees the keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") {
        e.preventDefault();
        e.stopPropagation();
        goTo(1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        e.stopPropagation();
        goTo(-1);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [goTo]);

  const handleDownload = async (e: React.MouseEvent) => {
    if (!attachment.gmail_attachment_id || saving) return;

    setSaving(true);
    try {
      // Plain click → Downloads folder, ⌘/Ctrl-click → choose a folder
      await saveAttachmentSmart(attachmentRef(attachment.account_id, attachment), e);
    } catch (err) {
      console.error("Failed to save attachment:", err);
    } finally {
      setSaving(false);
    }
  };

  const header = (
    <div className="px-4 py-3 border-b border-border-primary flex items-center justify-between shrink-0">
      <div className="flex items-center gap-2 min-w-0">
        <span>{getFileIcon(attachment.mime_type)}</span>
        <span className="text-sm font-medium text-text-primary truncate">
          {attachment.filename ?? "Unnamed"}
        </span>
        {attachment.size != null && (
          <span className="text-xs text-text-tertiary whitespace-nowrap">
            ({formatFileSize(attachment.size)})
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0 ml-4">
        {attachments.length > 1 && (
          <div className="flex items-center gap-1 mr-1">
            <Tooltip content="Previous attachment (←)"><button
              onClick={() => goTo(-1)}
              disabled={index === 0}

              className="p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors disabled:opacity-30"
            >
              <ChevronLeft size={16} />
            </button></Tooltip>
            <span className="text-xs text-text-tertiary whitespace-nowrap tabular-nums">
              {index + 1} / {attachments.length}
            </span>
            <Tooltip content="Next attachment (→)"><button
              onClick={() => goTo(1)}
              disabled={index === attachments.length - 1}

              className="p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors disabled:opacity-30"
            >
              <ChevronRight size={16} />
            </button></Tooltip>
          </div>
        )}
        <Tooltip content="Save to Downloads — ⌘-click to choose a folder"><button
          onClick={handleDownload}
          disabled={saving}

          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-accent hover:bg-accent-hover rounded-md transition-colors disabled:opacity-50"
        >
          <Download size={13} />
          {saving ? "Saving..." : "Download"}
        </button></Tooltip>
        <button
          onClick={onClose}
          className="text-text-tertiary hover:text-text-primary text-lg leading-none"
        >
          ×
        </button>
      </div>
    </div>
  );

  return (
    <Modal
      isOpen={true}
      onClose={onClose}
      title={attachment.filename ?? "Attachment"}
      width="w-[800px]"
      panelClassName="max-w-[90vw] max-h-[85vh] flex flex-col"
      renderHeader={header}
    >
      {/* Keyed by attachment so switching resets the loaded content */}
      <AttachmentPreviewBody key={attachment.id} attachment={attachment} />
    </Modal>
  );
}

/** Fetches and renders one attachment's content inside the preview modal. */
function AttachmentPreviewBody({ attachment }: { attachment: DbAttachment }) {
  const [loading, setLoading] = useState(false);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bytesRef = useRef<Uint8Array | null>(null);

  const isPreviewable = canPreview(attachment.mime_type, attachment.filename);

  const fetchData = useCallback(async (): Promise<Uint8Array> => {
    if (bytesRef.current) return bytesRef.current;
    const bytes = await fetchAttachmentBytes({
      accountId: attachment.account_id,
      messageId: attachment.message_id,
      gmailAttachmentId: attachment.gmail_attachment_id!,
      filename: attachment.filename,
    });
    bytesRef.current = bytes;
    return bytes;
  }, [attachment.account_id, attachment.message_id, attachment.gmail_attachment_id, attachment.filename]);

  const handlePreviewLoad = useCallback(async () => {
    if (!attachment.gmail_attachment_id || !isPreviewable || blobUrl) return;

    setLoading(true);
    try {
      const bytes = await fetchData();
      const effectiveMime = isPdf(attachment.mime_type, attachment.filename)
        ? "application/pdf"
        : (attachment.mime_type ?? "application/octet-stream");
      const blob = new Blob([bytes.buffer as ArrayBuffer], { type: effectiveMime });
      setBlobUrl(URL.createObjectURL(blob));
    } catch (err) {
      console.error("Failed to load preview:", err);
      setError("Failed to load preview");
    } finally {
      setLoading(false);
    }
  }, [attachment, isPreviewable, blobUrl, fetchData]);

  // Trigger preview load for previewable types
  useEffect(() => {
    if (isPreviewable && !blobUrl && !loading && !error) {
      handlePreviewLoad();
    }
  }, [isPreviewable, blobUrl, loading, error, handlePreviewLoad]);

  // Release the blob when this attachment leaves the modal
  useEffect(() => {
    return () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [blobUrl]);

  return (
    <>
      {/* Allow native right-click in preview (save image, copy, etc.) */}
      <div className="flex-1 overflow-auto min-h-[200px] flex items-center justify-center p-4" data-native-context-menu>
        {loading && (
          <p className="text-sm text-text-tertiary">Loading preview...</p>
        )}
        {error && (
          <p className="text-sm text-text-tertiary">{error}</p>
        )}
        {!loading && !error && blobUrl && isImage(attachment.mime_type) && (
          <img
            src={blobUrl}
            alt={attachment.filename ?? "Attachment"}
            className="max-w-full max-h-[70vh] object-contain rounded"
          />
        )}
        {!loading && !error && blobUrl && isPdf(attachment.mime_type, attachment.filename) && (
          <iframe
            src={blobUrl}
            title={attachment.filename ?? "PDF preview"}
            className="w-full h-[70vh] border-0 rounded"
          />
        )}
        {!loading && !error && blobUrl && isText(attachment.mime_type) && (
          <TextPreview url={blobUrl} />
        )}
        {!isPreviewable && !loading && (
          <div className="flex flex-col items-center gap-3 text-text-tertiary">
            <Eye size={40} strokeWidth={1} />
            <p className="text-sm">Preview not available for this file type</p>
            <p className="text-xs">{attachment.mime_type ?? "Unknown type"}</p>
          </div>
        )}
      </div>
    </>
  );
}

function TextPreview({ url }: { url: string }) {
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    fetch(url).then((r) => r.text()).then(setText).catch(() => setText("Failed to load text"));
  }, [url]);

  return (
    <pre className="text-xs text-text-secondary whitespace-pre-wrap font-mono w-full max-h-[70vh] overflow-auto bg-bg-tertiary rounded p-4">
      {text ?? "Loading..."}
    </pre>
  );
}

export { getAttachmentsForMessage };
