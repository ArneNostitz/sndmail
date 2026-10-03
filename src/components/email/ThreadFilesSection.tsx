import { useState, useEffect } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Paperclip, Download } from "lucide-react";
import { getAttachmentsForThread, type DbAttachment } from "@/services/db/attachments";
import {
  quickLookAttachments,
  saveAttachmentToFolder,
} from "@/services/attachments/attachmentActions";
import { formatFileSize, getFileIcon } from "@/utils/fileTypeHelpers";
import { AttachmentPreview, AttachmentSaveButton, attachmentRef } from "./AttachmentList";

import { Tooltip } from "@/components/ui/Tooltip";
interface ThreadFilesSectionProps {
  accountId: string;
  threadId: string;
}

/**
 * Keep only the latest copy of duplicated files (same name + size). The rows
 * arrive oldest-first, so walking from the end keeps the newest instance.
 */
export function dedupKeepLatest(all: DbAttachment[]): DbAttachment[] {
  const seen = new Set<string>();
  const kept: DbAttachment[] = [];
  for (let i = all.length - 1; i >= 0; i--) {
    const a = all[i]!;
    const key = `${a.filename}:${a.size}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.unshift(a);
  }
  return kept;
}

/**
 * "Files in this thread" — every attachment across the whole conversation,
 * with per-file Quick Look/preview and save, plus a save-all-into-folder action.
 */
export function ThreadFilesSection({ accountId, threadId }: ThreadFilesSectionProps) {
  const [files, setFiles] = useState<DbAttachment[]>([]);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [saveState, setSaveState] = useState<
    | { phase: "idle" }
    | { phase: "saving"; done: number; total: number }
    | { phase: "done"; total: number }
    | { phase: "failed" }
  >({ phase: "idle" });

  useEffect(() => {
    let cancelled = false;
    getAttachmentsForThread(accountId, threadId)
      .then((all) => {
        if (cancelled) return;
        // Skip inline images without a filename, then keep only the latest duplicate
        setFiles(
          dedupKeepLatest(
            all.filter((a) => {
              if (a.is_inline && !a.filename) return false;
              if (!a.gmail_attachment_id) return false;
              return true;
            }),
          ),
        );
      })
      .catch(() => {
        if (!cancelled) setFiles([]);
      });
    return () => { cancelled = true; };
  }, [accountId, threadId]);

  if (files.length === 0) return null;

  const handleSaveAll = async () => {
    if (saveState.phase === "saving") return;
    const dir = await open({ directory: true, multiple: false, title: "Save attachments to..." });
    if (!dir || Array.isArray(dir)) return;

    setSaveState({ phase: "saving", done: 0, total: files.length });
    let failed = 0;
    for (let i = 0; i < files.length; i++) {
      const att = files[i]!;
      try {
        await saveAttachmentToFolder(attachmentRef(accountId, att), dir);
      } catch (err) {
        console.error(`Failed to save ${att.filename}:`, err);
        failed++;
      }
      setSaveState({ phase: "saving", done: i + 1, total: files.length });
    }
    setSaveState(failed === files.length ? { phase: "failed" } : { phase: "done", total: files.length - failed });
    setTimeout(() => setSaveState({ phase: "idle" }), 3000);
  };

  const handleOpen = async (att: DbAttachment) => {
    const idx = files.findIndex((f) => f.id === att.id);
    if (idx < 0) return;
    // Quick Look on macOS with all thread files (←/→ moves through them);
    // the in-app preview everywhere else (and as fallback)
    try {
      if (await quickLookAttachments(files.map((f) => attachmentRef(accountId, f)), idx)) {
        return;
      }
    } catch (err) {
      console.error("Failed to open attachment:", err);
    }
    setPreviewIndex(idx);
  };

  return (
    <div className="mb-4">
      <div className="flex items-center justify-between mb-2">
        <h4 className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-text-tertiary">
          <Paperclip size={11} />
          Files in this thread
        </h4>
        <Tooltip content="Save all files to a folder"><button
          onClick={handleSaveAll}
          disabled={saveState.phase === "saving"}
          className="flex items-center gap-1 text-[0.625rem] text-accent hover:text-accent-hover transition-colors disabled:opacity-60"

        >
          <Download size={10} />
          {saveState.phase === "saving"
            ? `Saving ${saveState.done}/${saveState.total}...`
            : saveState.phase === "done"
              ? `Saved ${saveState.total}`
              : saveState.phase === "failed"
                ? "Failed — retry"
                : "Save all"}
        </button></Tooltip>
      </div>
      <div className="space-y-1">
        {files.map((att) => (
          <div
            key={att.id}
            className="flex items-center gap-2 px-2 py-1.5 text-xs rounded hover:bg-bg-hover transition-colors group"
          >
            <Tooltip content="Preview"><button
              onClick={() => handleOpen(att)}

              className="flex items-center gap-2 min-w-0 flex-1 text-left"
            >
              <span className="shrink-0">{getFileIcon(att.mime_type)}</span>
              <div className="min-w-0 flex-1">
                <div className="text-text-secondary truncate">{att.filename ?? "Unnamed"}</div>
                {att.size != null && (
                  <div className="text-text-tertiary text-[0.625rem]">{formatFileSize(att.size)}</div>
                )}
              </div>
            </button></Tooltip>
            <AttachmentSaveButton
              accountId={accountId}
              attachment={att}
              size={12}
              className="p-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
            />
          </div>
        ))}
      </div>

      {previewIndex !== null && (
        <AttachmentPreview
          attachments={files}
          startIndex={previewIndex}
          onClose={() => setPreviewIndex(null)}
        />
      )}
    </div>
  );
}
