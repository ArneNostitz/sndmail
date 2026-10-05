import { useState, useCallback, useEffect, useRef } from "react";
import { reportError } from "@/stores/toastStore";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { Reply, ReplyAll, Forward, Send, Maximize2, RotateCcw, X, Loader2 } from "lucide-react";
import { useAccountStore } from "@/stores/accountStore";
import { useComposerStore } from "@/stores/composerStore";
import { useUIStore } from "@/stores/uiStore";
import { sendEmail, archiveThread } from "@/services/emailActions";
import { buildRawEmail } from "@/utils/emailBuilder";
import { upsertContact } from "@/services/db/contacts";
import { getSetting } from "@/services/db/settings";
import { getDefaultSignature } from "@/services/db/signatures";
import { getAliasesForAccount, mapDbAlias, type SendAsAlias } from "@/services/db/sendAsAliases";
import { resolveFromAddress, recipientHeadersFromMessages } from "@/utils/resolveFromAddress";
import { extractEmailAddresses, normalizeEmail } from "@/utils/emailUtils";
import {
  isAutoDraftEnabled,
  generateAutoDraft,
  regenerateAutoDraft,
  type AutoDraftMode,
} from "@/services/ai/writingStyleService";
import type { DbMessage } from "@/services/db/messages";
import type { Thread } from "@/stores/threadStore";

type ReplyMode = "reply" | "replyAll" | "forward";

interface InlineReplyProps {
  thread: Thread;
  messages: DbMessage[];
  accountId: string;
  noReply?: boolean;
  onSent: () => void;
}

export function InlineReply({ thread, messages, accountId, noReply, onSent }: InlineReplyProps) {
  const [mode, setMode] = useState<ReplyMode | null>(null);
  const [sending, setSending] = useState(false);
  const [signatureHtml, setSignatureHtml] = useState("");
  const [autoDraftLoading, setAutoDraftLoading] = useState(false);
  const [hasAutoDraft, setHasAutoDraft] = useState(false);
  const [aliases, setAliases] = useState<SendAsAlias[]>([]);
  const [fromEmail, setFromEmail] = useState<string | null>(null);
  const accounts = useAccountStore((s) => s.accounts);
  const activeAccount = accounts.find((a) => a.id === accountId);
  const openComposer = useComposerStore((s) => s.openComposer);
  const containerRef = useRef<HTMLDivElement>(null);
  const focusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoDraftAbortRef = useRef(false);
  const messagesRef = useRef(messages);

  const lastMessage = messages[messages.length - 1];

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: false, link: { openOnClick: false } }),
      Placeholder.configure({
        placeholder: "Write your reply...",
      }),
    ],
    content: "",
    editorProps: {
      attributes: {
        class: "prose prose-sm max-w-none px-3 py-2 min-h-[80px] max-h-[200px] overflow-y-auto focus:outline-none text-text-primary text-sm",
      },
    },
  });

  const loadAutoDraft = useCallback(async (draftMode: AutoDraftMode) => {
    if (!editor) return;
    autoDraftAbortRef.current = false;
    setAutoDraftLoading(true);
    try {
      const enabled = await isAutoDraftEnabled();
      if (!enabled || autoDraftAbortRef.current) return;

      const draft = await generateAutoDraft(thread.id, accountId, messages, draftMode);
      if (autoDraftAbortRef.current || !draft) return;

      // Only set content if the editor is still empty (user hasn't typed)
      if (editor.isEmpty) {
        editor.commands.setContent(draft);
        setHasAutoDraft(true);
      }
    } catch (err) {
      console.warn("Auto-draft generation failed:", err);
    } finally {
      setAutoDraftLoading(false);
    }
  }, [editor, thread.id, accountId, messages]);

  const activateMode = useCallback((newMode: ReplyMode) => {
    setMode(newMode);
    setHasAutoDraft(false);
    autoDraftAbortRef.current = true; // Cancel any in-flight draft
    if (focusTimerRef.current) clearTimeout(focusTimerRef.current);
    focusTimerRef.current = setTimeout(() => editor?.commands.focus(), 50);

    // Trigger auto-draft for reply/replyAll (not forward)
    if (newMode === "reply" || newMode === "replyAll") {
      loadAutoDraft(newMode);
    }
  }, [editor, loadAutoDraft]);

  // Load default signature
  useEffect(() => {
    getDefaultSignature(accountId).then((sig) => {
      if (sig) setSignatureHtml(sig.body_html);
    });
  }, [accountId]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Pick the identity to reply from: the address this thread was delivered to,
  // falling back to the account's default alias. Re-resolved per thread only,
  // so a manual pick in the header survives a message reload.
  useEffect(() => {
    let cancelled = false;
    setFromEmail(null);
    getAliasesForAccount(accountId).then((dbAliases) => {
      if (cancelled) return;
      const mapped = dbAliases.map(mapDbAlias);
      setAliases(mapped);
      const resolved = resolveFromAddress(
        mapped,
        recipientHeadersFromMessages(messagesRef.current),
      );
      setFromEmail(resolved?.email ?? null);
    }).catch((err) => {
      console.error("Failed to load send-as aliases:", err);
    });
    return () => { cancelled = true; };
  }, [accountId, thread.id]);

  // Listen for inline reply events from keyboard shortcuts
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { mode: ReplyMode } | undefined;
      if (detail?.mode) {
        activateMode(detail.mode);
      }
    };
    window.addEventListener("snd-inline-reply", handler);
    return () => window.removeEventListener("snd-inline-reply", handler);
  }, [activateMode]);

  // Scroll into view when activated
  useEffect(() => {
    if (mode && containerRef.current) {
      containerRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [mode]);

  const getRecipients = useCallback((): { to: string[]; cc: string[] } => {
    if (!lastMessage) return { to: [], cc: [] };

    if (mode === "forward") return { to: [], cc: [] };

    const replyTo = lastMessage.reply_to ?? lastMessage.from_address;

    if (mode === "reply") {
      return { to: replyTo ? [replyTo] : [], cc: [] };
    }

    // replyAll
    const allTo = new Set<string>();
    if (replyTo) allTo.add(replyTo);
    if (lastMessage.to_addresses) {
      lastMessage.to_addresses.split(",").forEach((a) => allTo.add(a.trim()));
    }
    // Remove self from recipients — the account address and every send-as
    // alias, so a reply-all sent from an alias does not loop back to it.
    const own = new Set<string>();
    if (activeAccount?.email) own.add(normalizeEmail(activeAccount.email));
    for (const alias of aliases) own.add(normalizeEmail(alias.email));
    const isOwn = (address: string) =>
      extractEmailAddresses(address).some((a) => own.has(a));

    for (const address of [...allTo]) {
      if (isOwn(address)) allTo.delete(address);
    }

    const ccList: string[] = [];
    if (lastMessage.cc_addresses) {
      lastMessage.cc_addresses.split(",").forEach((a) => {
        const trimmed = a.trim();
        if (trimmed && !isOwn(trimmed)) ccList.push(trimmed);
      });
    }

    return { to: Array.from(allTo), cc: ccList };
  }, [lastMessage, mode, activeAccount?.email, aliases]);

  const getSubject = useCallback((): string => {
    const sub = lastMessage?.subject ?? "";
    if (mode === "forward") return sub.startsWith("Fwd:") ? sub : `Fwd: ${sub}`;
    return sub.startsWith("Re:") ? sub : `Re: ${sub}`;
  }, [lastMessage, mode]);

  const handleSend = useCallback(async () => {
    if (!activeAccount || !editor || sending) return;
    const { to, cc } = getRecipients();
    if (to.length === 0 && mode !== "forward") return;

    setSending(true);
    try {
      let html = editor.getHTML();
      if (signatureHtml) {
        html += `<div style="margin-top:16px;border-top:1px solid #e5e5e5;padding-top:12px">${signatureHtml}</div>`;
      }

      const raw = buildRawEmail({
        from: fromEmail ?? activeAccount.email,
        to,
        cc: cc.length > 0 ? cc : undefined,
        subject: getSubject(),
        htmlBody: html,
        inReplyTo: lastMessage?.id,
        threadId: thread.id,
      });

      // Get undo send delay
      const delaySetting = await getSetting("undo_send_delay_seconds");
      const delay = parseInt(delaySetting ?? "5", 10) * 1000;

      const { setUndoSendVisible, setUndoSendTimer } = useComposerStore.getState();
      setUndoSendVisible(true);

      let sendTimer: ReturnType<typeof setTimeout> | null = null;
      let sendStarted = false;
      const sendNow = async () => {
        if (sendStarted) return;
        sendStarted = true;
        useComposerStore.getState().clearUndoSend();
        try {
          await sendEmail(accountId, raw, thread.id);

          // Send & archive: remove from inbox if enabled
          if (useUIStore.getState().sendAndArchive) {
            try { await archiveThread(accountId, thread.id, []); } catch { /* ignore */ }
          }

          // Update contacts frequency
          for (const addr of [...to, ...cc]) {
            await upsertContact(addr, null);
          }
        } catch (err) {
          reportError("Reply not sent", err);
        } finally {
          useComposerStore.getState().clearUndoSend();
        }
      };
      const cancelSend = () => {
        if (sendTimer) clearTimeout(sendTimer);
        setSending(false);
      };
      const skipSend = () => {
        if (sendTimer) clearTimeout(sendTimer);
        void sendNow();
      };

      const composerState = useComposerStore.getState();
      composerState.setUndoSendDeadline(Date.now() + delay, delay);
      composerState.setUndoSendActions(cancelSend, skipSend);
      sendTimer = setTimeout(() => void sendNow(), delay);

      setUndoSendTimer(sendTimer);

      // Reset state
      editor.commands.setContent("");
      setMode(null);
      onSent();
    } catch (err) {
      reportError("Reply not sent", err);
    } finally {
      setSending(false);
    }
  }, [activeAccount, editor, sending, getRecipients, getSubject, signatureHtml, lastMessage, thread.id, accountId, mode, onSent, fromEmail]);

  const handleExpandToComposer = useCallback(() => {
    if (!editor || !lastMessage) return;
    const { to, cc } = getRecipients();
    const bodyHtml = editor.getHTML();

    openComposer({
      mode: mode === "forward" ? "forward" : mode === "replyAll" ? "replyAll" : "reply",
      to,
      cc,
      subject: getSubject(),
      bodyHtml,
      threadId: thread.id,
      inReplyToMessageId: lastMessage.id,
      originalRecipients: recipientHeadersFromMessages(messages),
      fromEmail,
      accountId,
    });

    // Reset inline state
    editor.commands.setContent("");
    setMode(null);
  }, [editor, lastMessage, messages, getRecipients, getSubject, mode, thread.id, accountId, openComposer, fromEmail]);

  const handleRegenerateDraft = useCallback(async () => {
    if (!editor || !mode || mode === "forward") return;
    autoDraftAbortRef.current = false;
    setAutoDraftLoading(true);
    try {
      const draft = await regenerateAutoDraft(thread.id, accountId, messages, mode);
      if (autoDraftAbortRef.current || !draft) return;
      editor.commands.setContent(draft);
      setHasAutoDraft(true);
    } catch (err) {
      console.warn("Auto-draft regeneration failed:", err);
    } finally {
      setAutoDraftLoading(false);
    }
  }, [editor, mode, thread.id, accountId, messages]);

  const handleClearDraft = useCallback(() => {
    if (!editor) return;
    editor.commands.setContent("");
    setHasAutoDraft(false);
    editor.commands.focus();
  }, [editor]);

  // Abort auto-draft on user typing
  useEffect(() => {
    if (!editor) return;
    const onUpdate = () => {
      if (autoDraftLoading) {
        autoDraftAbortRef.current = true;
      }
    };
    editor.on("update", onUpdate);
    return () => { editor.off("update", onUpdate); };
  }, [editor, autoDraftLoading]);

  // Cleanup focus timer on unmount
  useEffect(() => {
    return () => {
      if (focusTimerRef.current) clearTimeout(focusTimerRef.current);
      autoDraftAbortRef.current = true;
    };
  }, []);

  // Handle Ctrl+Enter to send, Escape to close
  useEffect(() => {
    if (!mode) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        handleSend();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        editor?.commands.setContent("");
        setMode(null);
        setHasAutoDraft(false);
        autoDraftAbortRef.current = true;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [mode, handleSend, editor]);

  if (!lastMessage) return null;

  // Collapsed state — show reply buttons
  if (!mode) {
    return (
      <div ref={containerRef} className="mx-4 my-3 flex items-center gap-2">
        <button
          onClick={() => activateMode("reply")}
          disabled={noReply}
          title={noReply ? "This sender does not accept replies" : undefined}
          className="flex items-center gap-1.5 px-4 py-2 text-xs text-text-secondary border border-border-primary rounded-lg hover:bg-bg-hover hover:text-text-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-text-secondary"
        >
          <Reply size={14} />
          Reply
        </button>
        <button
          onClick={() => activateMode("replyAll")}
          disabled={noReply}
          title={noReply ? "This sender does not accept replies" : undefined}
          className="flex items-center gap-1.5 px-4 py-2 text-xs text-text-secondary border border-border-primary rounded-lg hover:bg-bg-hover hover:text-text-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-text-secondary"
        >
          <ReplyAll size={14} />
          Reply All
        </button>
        <button
          onClick={() => activateMode("forward")}
          className="flex items-center gap-1.5 px-4 py-2 text-xs text-text-secondary border border-border-primary rounded-lg hover:bg-bg-hover hover:text-text-primary transition-colors"
        >
          <Forward size={14} />
          Forward
        </button>
      </div>
    );
  }

  // Expanded state — editor visible
  const { to } = getRecipients();
  const modeLabel = mode === "reply" ? "Reply" : mode === "replyAll" ? "Reply All" : "Forward";

  return (
    <div ref={containerRef} className="mx-4 my-3 border border-border-primary rounded-lg overflow-hidden bg-bg-primary">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-bg-secondary border-b border-border-secondary">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1">
            {(["reply", "replyAll", "forward"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`px-2 py-1 text-[0.6875rem] rounded transition-colors ${
                  mode === m
                    ? "bg-accent/10 text-accent font-medium"
                    : "text-text-tertiary hover:text-text-primary"
                }`}
              >
                {m === "reply" ? "Reply" : m === "replyAll" ? "Reply All" : "Forward"}
              </button>
            ))}
          </div>
          {to.length > 0 && (
            <span className="text-[0.6875rem] text-text-tertiary truncate max-w-[200px]">
              to {to.join(", ")}
            </span>
          )}
          {aliases.length > 1 && (
            <label className="flex items-center gap-1 text-[0.6875rem] text-text-tertiary">
              from
              <select
                value={fromEmail ?? activeAccount?.email ?? ""}
                onChange={(e) => setFromEmail(e.target.value)}
                className="bg-transparent text-[0.6875rem] text-text-secondary outline-none cursor-pointer hover:text-text-primary rounded border-none max-w-[180px]"
              >
                {aliases.map((alias) => (
                  <option key={alias.id} value={alias.email}>
                    {alias.email}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <button
          onClick={() => setMode(null)}
          className="text-xs text-text-tertiary hover:text-text-primary transition-colors"
        >
          Cancel
        </button>
      </div>

      {/* Editor */}
      <div className="relative">
        <EditorContent editor={editor} />
        {autoDraftLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-bg-primary/60 backdrop-blur-[1px]">
            <div className="flex items-center gap-2 text-xs text-text-secondary">
              <Loader2 size={14} className="animate-spin" />
              Generating draft...
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between px-3 py-2 border-t border-border-secondary bg-bg-secondary">
        <div className="flex items-center gap-1">
          <button
            onClick={handleExpandToComposer}
            title="Expand to full composer"
            className="flex items-center gap-1.5 px-2 py-1 text-xs text-text-tertiary hover:text-text-primary transition-colors"
          >
            <Maximize2 size={12} />
            Expand
          </button>
          {hasAutoDraft && mode !== "forward" && (
            <>
              <button
                onClick={handleRegenerateDraft}
                disabled={autoDraftLoading}
                title="Regenerate AI draft"
                className="flex items-center gap-1 px-2 py-1 text-xs text-text-tertiary hover:text-accent transition-colors disabled:opacity-50"
              >
                <RotateCcw size={11} />
                Regenerate
              </button>
              <button
                onClick={handleClearDraft}
                title="Clear AI draft"
                className="flex items-center gap-1 px-2 py-1 text-xs text-text-tertiary hover:text-danger transition-colors"
              >
                <X size={11} />
                Clear
              </button>
            </>
          )}
        </div>
        <button
          onClick={handleSend}
          disabled={sending || (to.length === 0 && mode !== "forward")}
          className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium text-white bg-accent hover:bg-accent-hover rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Send size={12} />
          {modeLabel}
        </button>
      </div>
    </div>
  );
}
