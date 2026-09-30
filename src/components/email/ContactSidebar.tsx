import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  Mail, Clock, X, Send, Copy, Star, UserPlus, Check, PenLine,
  Paperclip, Building2, ChevronDown, ChevronRight, Pin,
} from "lucide-react";
import {
  getContactByEmail, getContactStats,
  upsertContact, updateContact, updateContactNotes,
  getAttachmentsFromContact, getContactsFromSameDomain, getLatestAuthResult,
  type ContactStats, type DbContact, type ContactAttachment, type SameDomainContact,
} from "@/services/db/contacts";
import { isVipSender, addVipSender, removeVipSender } from "@/services/db/notificationVips";
import { fetchAndCacheGravatarUrl } from "@/services/contacts/gravatar";
import { useUIStore } from "@/stores/uiStore";
import { useComposerStore } from "@/stores/composerStore";
import { getThreadsWithContact } from "@/services/db/threads";
import { cacheThreadForOpening } from "@/services/threads/openThread";
import { navigateToThread } from "@/router/navigate";
import { formatRelativeDate } from "@/utils/date";
import { formatFileSize, getFileIcon } from "@/utils/fileTypeHelpers";
import { AuthBadge } from "./AuthBadge";
import { ThreadFilesSection } from "./ThreadFilesSection";
import { AttachmentPreview, AttachmentSaveButton, attachmentRef } from "./AttachmentList";
import { quickLookAttachments } from "@/services/attachments/attachmentActions";
import type { DbAttachment } from "@/services/db/attachments";
import { useTimeFormat } from "@/hooks/useTimeFormat";

export function DetailsPlaceholder({ onClose }: { onClose: () => void }) {
  return (
    <aside className="flex h-full w-full flex-col bg-bg-primary">
      <div className="flex h-12 items-center justify-between border-b border-border-secondary px-3">
        <h2 className="text-xs font-semibold text-text-primary">Details</h2>
        <button onClick={onClose} aria-label="Hide details" className="toolbar-icon-button h-7 w-7">
          <X size={14} />
        </button>
      </div>
      <p className="px-3 py-4 text-xs leading-5 text-text-tertiary">Select a conversation to see contact details.</p>
    </aside>
  );
}

/** Shared-files rows come from the contacts query; the attachment tools want the attachments-table shape. */
function toDbAttachment(att: ContactAttachment): DbAttachment {
  return {
    id: att.id,
    message_id: att.message_id,
    account_id: att.account_id,
    filename: att.filename,
    mime_type: att.mime_type,
    size: att.size,
    gmail_attachment_id: att.gmail_attachment_id,
    content_id: null,
    is_inline: 0,
    local_path: null,
  };
}

interface ContactSidebarProps {
  email: string;
  name: string | null;
  accountId: string;
  threadId?: string;
  /** Lowercased addresses the user sends from, so "recent" means an exchange. */
  ownAddresses?: Set<string>;
  onClose: () => void;
}

export function ContactSidebar({ email, name, accountId, threadId, ownAddresses, onClose }: ContactSidebarProps) {
  // A Set identity changes every render of the parent; the addresses do not
  const ownAddressKey = ownAddresses ? [...ownAddresses].sort().join(",") : "";
  const ownAddressList = useMemo(
    () => (ownAddressKey ? ownAddressKey.split(",") : []),
    [ownAddressKey],
  );
  // Repaint when the 12/24-hour preference changes
  useTimeFormat();
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [stats, setStats] = useState<ContactStats | null>(null);
  const [recentThreads, setRecentThreads] = useState<{ thread_id: string; subject: string | null; last_message_at: number | null }[]>([]);
  const [contact, setContact] = useState<DbContact | null>(null);
  const [isVip, setIsVip] = useState(false);
  const [notes, setNotes] = useState("");
  const [notesExpanded, setNotesExpanded] = useState(false);
  const [attachments, setAttachments] = useState<ContactAttachment[]>([]);
  const [filePreviewIndex, setFilePreviewIndex] = useState<number | null>(null);
  // The files ←/→ can move through in the preview: every fetchable shared file
  const openableFiles = useMemo(
    () => attachments.filter((a) => a.gmail_attachment_id).map(toDbAttachment),
    [attachments],
  );
  const [sameDomainContacts, setSameDomainContacts] = useState<SameDomainContact[]>([]);
  const [authResults, setAuthResults] = useState<string | null>(null);
  const [copyFeedback, setCopyFeedback] = useState(false);
  const [addedFeedback, setAddedFeedback] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [editNameValue, setEditNameValue] = useState("");

  const loadedRef = useRef<string | null>(null);
  const notesTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const addedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleThreadClick = useCallback(async (threadId: string) => {
    // Stay on this person while their conversations are browsed
    useUIStore.getState().pinContact({ email, name: name ?? null });

    // Cached rather than appended to the list: browsing someone's past
    // conversations should not rearrange the mailbox you are looking at.
    if (!(await cacheThreadForOpening(accountId, threadId))) return;
    navigateToThread(threadId);
  }, [accountId, email, name]);

  useEffect(() => {
    if (!email) return;
    loadedRef.current = email;
    let cancelled = false;

    // Load contact + avatar
    getContactByEmail(email).then((c) => {
      if (cancelled) return;
      setContact(c);
      setNotes(c?.notes ?? "");
      if (c?.avatar_url) {
        setAvatarUrl(c.avatar_url);
      } else {
        fetchAndCacheGravatarUrl(email).then((url) => {
          if (!cancelled) setAvatarUrl(url);
        });
      }
    });

    // Load stats
    getContactStats(email).then((s) => { if (!cancelled) setStats(s); });

    // Load recent threads
    // Threads the two of them actually exchanged, in this mailbox — matching
    // on "they sent it" alone listed every unrelated mail from that address
    getThreadsWithContact(accountId, email, null, ownAddressList, 5).then((rows) => {
      if (cancelled) return;
      setRecentThreads(rows.map((r) => ({
        thread_id: r.id,
        subject: r.subject,
        last_message_at: r.last_message_at,
      })));
    }).catch(() => { if (!cancelled) setRecentThreads([]); });

    // Load VIP status
    isVipSender(accountId, email).then((v) => { if (!cancelled) setIsVip(v); });

    // Load attachments from contact
    getAttachmentsFromContact(email).then((a) => { if (!cancelled) setAttachments(a); });

    // Load same-domain contacts
    getContactsFromSameDomain(email).then((c) => { if (!cancelled) setSameDomainContacts(c); });

    // Load auth results
    getLatestAuthResult(email).then((r) => { if (!cancelled) setAuthResults(r); });

    return () => { cancelled = true; };
  }, [email, accountId, ownAddressKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // -- Event handlers --

  const handleCompose = useCallback(() => {
    useComposerStore.getState().openComposer({ mode: "new", to: [email] });
  }, [email]);

  const handleCopyEmail = useCallback(() => {
    navigator.clipboard.writeText(email);
    setCopyFeedback(true);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopyFeedback(false), 1500);
  }, [email]);

  const handleToggleVip = useCallback(async () => {
    if (isVip) {
      await removeVipSender(accountId, email);
      setIsVip(false);
    } else {
      await addVipSender(accountId, email, name ?? undefined);
      setIsVip(true);
    }
  }, [accountId, email, name, isVip]);

  const handleNotesChange = useCallback((value: string) => {
    setNotes(value);
    if (notesTimerRef.current) clearTimeout(notesTimerRef.current);
    notesTimerRef.current = setTimeout(() => {
      updateContactNotes(email, value);
    }, 1000);
  }, [email]);

  const handleNotesBlur = useCallback(() => {
    if (notesTimerRef.current) {
      clearTimeout(notesTimerRef.current);
      notesTimerRef.current = null;
    }
    updateContactNotes(email, notes);
  }, [email, notes]);

  const handleAddContact = useCallback(async () => {
    await upsertContact(email, name);
    const c = await getContactByEmail(email);
    setContact(c);
    setAddedFeedback(true);
    if (addedTimerRef.current) clearTimeout(addedTimerRef.current);
    addedTimerRef.current = setTimeout(() => setAddedFeedback(false), 1500);
  }, [email, name]);

  const handleStartEditName = useCallback(() => {
    setEditNameValue(contact?.display_name ?? name ?? "");
    setEditingName(true);
  }, [contact, name]);

  const handleSaveEditName = useCallback(async () => {
    if (!contact) return;
    const trimmed = editNameValue.trim();
    await updateContact(contact.id, trimmed || null);
    setContact({ ...contact, display_name: trimmed || null });
    setEditingName(false);
  }, [contact, editNameValue]);

  // Cleanup all timers on unmount
  useEffect(() => {
    return () => {
      if (notesTimerRef.current) clearTimeout(notesTimerRef.current);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      if (addedTimerRef.current) clearTimeout(addedTimerRef.current);
    };
  }, []);

  const displayName = contact?.display_name ?? name ?? email.split("@")[0];
  const initial = (displayName?.[0] ?? "?").toUpperCase();
  const pinnedContact = useUIStore((s) => s.pinnedContact);
  const clearPinnedContact = useUIStore((s) => s.clearPinnedContact);
  const isPinned = pinnedContact?.email === email;

  const domain = email.includes("@") ? email.split("@")[1] : null;

  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="p-3">
        {/* Pin state + close */}
        <div className="flex items-center justify-between gap-2 -mt-1 -mr-1 mb-1 min-h-[1.5rem]">
          {isPinned ? (
            <button
              onClick={() => clearPinnedContact()}
              title="Stop following this contact and go back to the open message's sender"
              className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[0.625rem] text-accent bg-accent/10 hover:bg-accent/20 transition-colors"
            >
              <Pin size={10} />
              Pinned
            </button>
          ) : (
            <span />
          )}
          <button
            onClick={onClose}
            title="Close contact sidebar"
            className="p-1 text-text-tertiary hover:text-text-primary hover:bg-bg-hover rounded transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        {/* Avatar */}
        <div className="flex flex-col items-center text-center mb-4">
          {avatarUrl ? (
            <img
              src={avatarUrl}
              alt={displayName}
              className="w-16 h-16 rounded-full mb-2"
            />
          ) : (
            <div className="w-16 h-16 rounded-full bg-accent/20 text-accent flex items-center justify-center text-xl font-semibold mb-2">
              {initial}
            </div>
          )}

          {/* Name + Auth Badge */}
          {editingName ? (
            <div className="flex items-center gap-1 mb-0.5">
              <input
                type="text"
                value={editNameValue}
                onChange={(e) => setEditNameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSaveEditName();
                  if (e.key === "Escape") setEditingName(false);
                }}
                autoFocus
                className="w-36 text-sm text-center bg-bg-primary border border-border-primary rounded px-1.5 py-0.5 text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
              />
              <button
                onClick={handleSaveEditName}
                title="Save name"
                className="p-0.5 text-success hover:text-success/80 transition-colors"
              >
                <Check size={14} />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-1 text-sm font-medium text-text-primary">
              <span>{displayName}</span>
              <AuthBadge authResults={authResults} />
            </div>
          )}

          <div className="text-xs text-text-tertiary mt-0.5">
            {email}
          </div>
        </div>

        {/* Quick Actions Row */}
        <div className="flex items-center justify-center gap-3 mb-4">
          <button
            onClick={handleCompose}
            title="Send email"
            className="p-2 text-text-secondary hover:text-accent hover:bg-bg-hover rounded-lg transition-colors"
          >
            <Send size={16} />
          </button>
          <button
            onClick={handleCopyEmail}
            title={copyFeedback ? "Copied!" : "Copy email"}
            className="p-2 text-text-secondary hover:text-accent hover:bg-bg-hover rounded-lg transition-colors"
          >
            {copyFeedback ? <Check size={16} className="text-success" /> : <Copy size={16} />}
          </button>
          <button
            onClick={handleToggleVip}
            title={isVip ? "Remove VIP" : "Mark as VIP"}
            className={`p-2 rounded-lg transition-colors ${
              isVip
                ? "text-warning hover:text-warning/80 hover:bg-bg-hover"
                : "text-text-secondary hover:text-warning hover:bg-bg-hover"
            }`}
          >
            <Star size={16} fill={isVip ? "currentColor" : "none"} />
          </button>
        </div>

        {/* Add / Edit Contact */}
        {!contact ? (
          <button
            onClick={handleAddContact}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium text-accent border border-accent/30 rounded-md hover:bg-accent/10 transition-colors mb-4"
          >
            {addedFeedback ? (
              <>
                <Check size={12} className="text-success" />
                <span className="text-success">Added!</span>
              </>
            ) : (
              <>
                <UserPlus size={12} />
                <span>Add to Contacts</span>
              </>
            )}
          </button>
        ) : !editingName ? (
          <button
            onClick={handleStartEditName}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-1 text-xs text-text-tertiary hover:text-text-secondary transition-colors mb-4"
          >
            <PenLine size={11} />
            <span>Edit name</span>
          </button>
        ) : null}

        {/* Stats */}
        {stats && (
          <div className="space-y-2 mb-4">
            <div className="flex items-center gap-2 text-xs text-text-secondary">
              <Mail size={12} className="text-text-tertiary shrink-0" />
              <span>{stats.emailCount} emails</span>
            </div>
            {stats.firstEmail && (
              <div className="flex items-center gap-2 text-xs text-text-secondary">
                <Clock size={12} className="text-text-tertiary shrink-0" />
                <span>First email: {formatRelativeDate(stats.firstEmail)}</span>
              </div>
            )}
            {stats.lastEmail && (
              <div className="flex items-center gap-2 text-xs text-text-secondary">
                <Clock size={12} className="text-text-tertiary shrink-0" />
                <span>Last email: {formatRelativeDate(stats.lastEmail)}</span>
              </div>
            )}
          </div>
        )}

        {/* Contact Notes */}
        {contact && (
          <div className="mb-4">
            <button
              onClick={() => setNotesExpanded(!notesExpanded)}
              className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-text-tertiary mb-2 hover:text-text-secondary transition-colors"
            >
              {notesExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              Notes
            </button>
            {notesExpanded && (
              <textarea
                value={notes}
                onChange={(e) => handleNotesChange(e.target.value)}
                onBlur={handleNotesBlur}
                placeholder="Add a note..."
                rows={3}
                className="w-full text-xs bg-bg-primary border border-border-primary rounded-md px-2 py-1.5 text-text-secondary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent resize-y"
              />
            )}
          </div>
        )}

        {/* Files across all messages of the open thread */}
        {threadId && <ThreadFilesSection accountId={accountId} threadId={threadId} />}

        {/* Shared Files */}
        {attachments.length > 0 && (
          <div className="mb-4">
            <h4 className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-text-tertiary mb-2">
              <Paperclip size={11} />
              Shared Files
            </h4>
            <div className="space-y-1">
              {attachments.map((att) => {
                const dbAtt = toDbAttachment(att);
                return (
                  <div
                    key={att.id}
                    className="flex items-center gap-2 px-2 py-1.5 text-xs rounded hover:bg-bg-hover transition-colors group"
                  >
                    <button
                      onClick={async () => {
                        const idx = openableFiles.findIndex((f) => f.id === att.id);
                        if (idx < 0) return;
                        // Quick Look on macOS with all shared files
                        // (←/→ moves through them); in-app preview as fallback
                        try {
                          if (
                            await quickLookAttachments(
                              openableFiles.map((f) => attachmentRef(f.account_id, f)),
                              idx,
                            )
                          ) {
                            return;
                          }
                        } catch (err) {
                          console.error("Failed to open attachment:", err);
                        }
                        setFilePreviewIndex(idx);
                      }}
                      disabled={!att.gmail_attachment_id}
                      title={att.gmail_attachment_id ? "Preview" : "File content not available"}
                      className="flex items-center gap-2 min-w-0 flex-1 text-left disabled:cursor-default"
                    >
                      <span className="shrink-0">{getFileIcon(att.mime_type)}</span>
                      <div className="min-w-0 flex-1">
                        <div className="text-text-secondary truncate">{att.filename}</div>
                        <div className="text-text-tertiary text-[0.625rem]">
                          {att.size != null && formatFileSize(att.size)}
                          {att.size != null && " \u00B7 "}
                          {formatRelativeDate(att.date)}
                        </div>
                      </div>
                    </button>
                    {/* A file is only ever half the story — the mail it came
                        in usually says why it was sent */}
                    <button
                      onClick={() => handleThreadClick(att.thread_id)}
                      title="Open the email this file came in"
                      className="p-1 text-text-tertiary hover:text-accent opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-colors"
                    >
                      <Mail size={12} />
                    </button>
                    <AttachmentSaveButton
                      accountId={att.account_id}
                      attachment={dbAtt}
                      size={12}
                      className="p-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
                    />
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {filePreviewIndex !== null && openableFiles.length > 0 && (
          <AttachmentPreview
            attachments={openableFiles}
            startIndex={filePreviewIndex}
            onClose={() => setFilePreviewIndex(null)}
          />
        )}

        {/* Same-Domain Contacts */}
        {sameDomainContacts.length > 0 && domain && (
          <div className="mb-4">
            <h4 className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-text-tertiary mb-2">
              <Building2 size={11} />
              Others at @{domain}
            </h4>
            <div className="space-y-1">
              {sameDomainContacts.map((c) => (
                <div
                  key={c.email}
                  className="flex items-center gap-2 px-2 py-1.5 text-xs rounded hover:bg-bg-hover transition-colors"
                >
                  {c.avatar_url ? (
                    <img src={c.avatar_url} alt="" className="w-5 h-5 rounded-full shrink-0" />
                  ) : (
                    <div className="w-5 h-5 rounded-full bg-accent/20 text-accent flex items-center justify-center text-[0.5rem] font-semibold shrink-0">
                      {(c.display_name?.[0] ?? c.email[0] ?? "?").toUpperCase()}
                    </div>
                  )}
                  <div className="min-w-0">
                    <div className="text-text-secondary truncate">
                      {c.display_name ?? c.email.split("@")[0]}
                    </div>
                    <div className="text-text-tertiary text-[0.625rem] truncate">{c.email}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Recent threads */}
        {recentThreads.length > 0 && (
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wider text-text-tertiary mb-2">
              Recent Conversations
            </h4>
            <div className="space-y-1">
              {recentThreads.map((thread) => (
                <button
                  key={thread.thread_id}
                  onClick={() => handleThreadClick(thread.thread_id)}
                  className="w-full text-left px-2 py-1.5 text-xs rounded hover:bg-bg-hover transition-colors group"
                >
                  <div className="text-text-secondary group-hover:text-text-primary truncate">
                    {thread.subject ?? "(No subject)"}
                  </div>
                  {thread.last_message_at && (
                    <div className="text-text-tertiary text-[0.625rem] mt-0.5">
                      {formatRelativeDate(thread.last_message_at)}
                    </div>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
