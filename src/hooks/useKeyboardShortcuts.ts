import { useEffect, useRef } from "react";
import { useUIStore } from "@/stores/uiStore";
import { useThreadStore } from "@/stores/threadStore";
import { useComposerStore } from "@/stores/composerStore";
import { useAccountStore } from "@/stores/accountStore";
import { useShortcutStore } from "@/stores/shortcutStore";
import { useContextMenuStore } from "@/stores/contextMenuStore";
import { navigateToLabel, navigateToThread, navigateBack, getActiveLabel, getSelectedThreadId } from "@/router/navigate";
import { archiveThread, trashThread, permanentDeleteThread, starThread, spamThread, runBulkAction, type BulkTarget } from "@/services/emailActions";
import { confirmDelete } from "@/utils/confirmDelete";
import { deleteThread as deleteThreadFromDb, pinThread as pinThreadDb, unpinThread as unpinThreadDb, muteThread as muteThreadDb, unmuteThread as unmuteThreadDb } from "@/services/db/threads";
import { deleteDraftsForThread } from "@/services/gmail/draftDeletion";
import { getGmailClient } from "@/services/gmail/tokenManager";
import { getMessagesForThread } from "@/services/db/messages";
import { parseUnsubscribeUrl } from "@/components/email/MessageItem";
import { openUrl } from "@tauri-apps/plugin-opener";
import { refreshMail } from "@/services/refreshMail";

/**
 * Parse a key binding string and check if it matches a keyboard event.
 * Supports formats like: "j", "#", "Ctrl+K", "Ctrl+Shift+E", "Ctrl+Enter"
 */
export function matchesKey(binding: string, e: KeyboardEvent): boolean {
  const parts = binding.split("+");
  const key = parts[parts.length - 1]!;
  const needsCtrl = parts.some((p) => p === "Ctrl" || p === "Cmd");
  const needsShift = parts.some((p) => p === "Shift");
  const needsAlt = parts.some((p) => p === "Alt");

  const ctrlMatch = needsCtrl ? (e.ctrlKey || e.metaKey) : !(e.ctrlKey || e.metaKey);
  const shiftMatch = needsShift ? e.shiftKey : !e.shiftKey;
  const altMatch = needsAlt ? e.altKey : !e.altKey;

  // For single character keys, compare case-insensitively
  const keyMatch = key.length === 1
    ? e.key === key || e.key === key.toLowerCase() || e.key === key.toUpperCase()
    : e.key === key;

  return ctrlMatch && shiftMatch && altMatch && keyMatch;
}

/**
 * Build a reverse map: key binding -> action ID.
 * For "g then X" sequences, stores as "g then X" literally.
 */
function buildReverseMap(keyMap: Record<string, string>): {
  singleKey: Map<string, string>;
  twoKeySequences: Map<string, string>; // second key -> action ID (first key is always "g")
  modifiedCombos: Map<string, string>;
} {
  const singleKey = new Map<string, string>();
  const twoKeySequences = new Map<string, string>();
  const modifiedCombos = new Map<string, string>();

  for (const [id, keys] of Object.entries(keyMap)) {
    if (keys.includes(" then ")) {
      // Two-key sequence like "g then i"
      const secondKey = keys.split(" then ")[1]!.trim();
      twoKeySequences.set(secondKey, id);
    } else if (/^(?:(?:Ctrl|Cmd|Alt|Shift)\+)+/.test(keys)) {
      modifiedCombos.set(id, keys);
    } else {
      singleKey.set(keys, id);
    }
  }

  return { singleKey, twoKeySequences, modifiedCombos };
}

// Cached reverse map to avoid rebuilding on every keypress
let cachedKeyMap: Record<string, string> | null = null;
let cachedReverseMap: ReturnType<typeof buildReverseMap> | null = null;

function getCachedReverseMap(keyMap: Record<string, string>): ReturnType<typeof buildReverseMap> {
  if (cachedKeyMap === keyMap && cachedReverseMap) return cachedReverseMap;
  cachedKeyMap = keyMap;
  cachedReverseMap = buildReverseMap(keyMap);
  return cachedReverseMap;
}

/**
 * Shortcuts that belong to the app rather than to the mail list — they still
 * run while a message is being typed, because none of them acts on the thread
 * behind the thing with the keyboard.
 */
function isAppLevelAction(actionId: string): boolean {
  return actionId.startsWith("app.");
}

/**
 * Global keyboard shortcuts handler (Superhuman-inspired).
 * Uses customizable key bindings from the shortcut store.
 */
export function useKeyboardShortcuts() {
  const pendingKeyRef = useRef<string | null>(null);
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      // Close context menu on Escape before any other handling
      if (e.key === "Escape" && useContextMenuStore.getState().menuType) {
        e.preventDefault();
        useContextMenuStore.getState().closeMenu();
        return;
      }

      const target = e.target as HTMLElement;
      const isInputFocused =
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable;

      const keyMap = useShortcutStore.getState().keyMap;
      const { singleKey, twoKeySequences, modifiedCombos } = getCachedReverseMap(keyMap);

      // While the settings dialog is open, only its own toggle binding runs —
      // mail shortcuts (j/k/e/#/...) must not fire behind the overlay.
      if (useUIStore.getState().settingsOpen) {
        const settingsBinding = keyMap["app.settings"] ?? "Ctrl+,";
        if (matchesKey(settingsBinding, e)) {
          e.preventDefault();
          useUIStore.getState().toggleSettings();
        }
        return;
      }

      const composerOpen = useComposerStore.getState().isOpen;

      // Modified shortcuts reach further than the rest, but not past what has
      // the keyboard: `Ctrl+A` in the composer means "select this message",
      // and it used to select — and a following Delete then trashed — every
      // thread in the list behind it. Only the app-level combos (palette,
      // settings, sidebar, send) run while something is being typed into.
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) {
        for (const [actionId, binding] of modifiedCombos) {
          if (matchesKey(binding, e)) {
            if (!isAppLevelAction(actionId) && (isInputFocused || composerOpen)) return;
            e.preventDefault();
            executeAction(actionId);
            return;
          }
        }
      }

      if (e.ctrlKey || e.metaKey) {
        // Ctrl+K for command palette (also check binding)
        if (e.key === "k" && !e.shiftKey) {
          const paletteBinding = keyMap["app.commandPalette"];
          if (paletteBinding === "Ctrl+K" || paletteBinding === "/" || !paletteBinding) {
            e.preventDefault();
            window.dispatchEvent(new Event("sndmail-toggle-command-palette"));
            return;
          }
        }
        if (e.key === "Enter") {
          // Send email shortcut handled by composer
          return;
        }
        return;
      }

      // F5 sync works even when input is focused
      if (e.key === "F5") {
        e.preventDefault();
        const syncActionId = singleKey.get("F5");
        if (syncActionId) {
          await executeAction(syncActionId);
        }
        return;
      }

      // The composer owns the keyboard while it is open. Only Escape gets
      // through, and only to close it — every other key belongs to the
      // message being written, not to the mail behind it.
      if (composerOpen) {
        if (matchesKey(keyMap["nav.escape"] ?? "Escape", e)) {
          e.preventDefault();
          executeAction("nav.escape");
        }
        return;
      }

      // Don't process single-key shortcuts when typing in inputs
      if (isInputFocused) return;

      const key = e.key;

      // Handle two-key sequences (pending "g" key)
      if (pendingKeyRef.current === "g") {
        pendingKeyRef.current = null;
        if (pendingTimerRef.current) {
          clearTimeout(pendingTimerRef.current);
          pendingTimerRef.current = null;
        }
        const actionId = twoKeySequences.get(key);
        if (actionId) {
          e.preventDefault();
          executeAction(actionId);
          return;
        }
      }

      // Check if "g" starts a two-key sequence
      if (key === "g" && twoKeySequences.size > 0) {
        pendingKeyRef.current = "g";
        pendingTimerRef.current = setTimeout(() => {
          pendingKeyRef.current = null;
        }, 1000);
        return;
      }

      // Arrow keys navigate the thread list when no thread is open full-screen
      // (In split-pane mode or list-only view, arrows move between threads)
      if (key === "ArrowDown" || key === "ArrowUp") {
        const selectedId = getSelectedThreadId();
        const paneOff = useUIStore.getState().readingPanePosition === "hidden";
        // Only handle here if no thread is open in full-screen mode
        // (when pane is off and a thread is selected, ThreadView handles arrows for message nav)
        if (!(paneOff && selectedId)) {
          e.preventDefault();
          await executeAction(key === "ArrowDown" ? "nav.next" : "nav.prev");
          return;
        }
      }

      // Single key shortcuts
      let actionId = singleKey.get(key);
      // Delete and Backspace always trigger delete action
      if (!actionId && (key === "Delete" || key === "Backspace")) {
        actionId = "action.delete";
      }
      if (actionId) {
        e.preventDefault();
        await executeAction(actionId);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
}

async function executeAction(actionId: string): Promise<void> {
  const threads = useThreadStore.getState().threads;
  const selectedId = getSelectedThreadId();
  const currentIdx = threads.findIndex((t) => t.id === selectedId);
  // In the unified list the selected thread may belong to a different mailbox
  // than the sidebar's — act on the thread's own account.
  const activeAccountId =
    threads.find((t) => t.id === selectedId)?.accountId ??
    useAccountStore.getState().activeAccountId;
  // A multi-selection in the unified list can span mailboxes, so each thread
  // has to be acted on through its own account.
  const accountFor = (threadId: string): string | null =>
    threads.find((t) => t.id === threadId)?.accountId ?? activeAccountId;
  const targetsFor = (ids: Iterable<string>): BulkTarget[] => {
    const targets: BulkTarget[] = [];
    for (const threadId of ids) {
      const accountId = accountFor(threadId);
      if (accountId) targets.push({ accountId, threadId });
    }
    return targets;
  };

  switch (actionId) {
    case "nav.next": {
      const nextIdx = Math.min(currentIdx + 1, threads.length - 1);
      if (threads[nextIdx]) {
        navigateToThread(threads[nextIdx].id);
      }
      break;
    }
    case "nav.prev": {
      const prevIdx = Math.max(currentIdx - 1, 0);
      if (threads[prevIdx]) {
        navigateToThread(threads[prevIdx].id);
      }
      break;
    }
    case "nav.open": {
      if (!selectedId && threads[0]) {
        navigateToThread(threads[0].id);
      }
      break;
    }
    case "nav.goInbox":
      navigateToLabel("inbox");
      break;
    case "nav.goStarred":
      navigateToLabel("starred");
      break;
    case "nav.goSent":
      navigateToLabel("sent");
      break;
    case "nav.goDrafts":
      navigateToLabel("drafts");
      break;
    case "nav.goPrimary":
      if (useUIStore.getState().inboxViewMode === "split") {
        navigateToLabel("inbox", { category: "Primary" });
      }
      break;
    case "nav.goUpdates":
      if (useUIStore.getState().inboxViewMode === "split") {
        navigateToLabel("inbox", { category: "Updates" });
      }
      break;
    case "nav.goPromotions":
      if (useUIStore.getState().inboxViewMode === "split") {
        navigateToLabel("inbox", { category: "Promotions" });
      }
      break;
    case "nav.goSocial":
      if (useUIStore.getState().inboxViewMode === "split") {
        navigateToLabel("inbox", { category: "Social" });
      }
      break;
    case "nav.goNewsletters":
      if (useUIStore.getState().inboxViewMode === "split") {
        navigateToLabel("inbox", { category: "Newsletters" });
      }
      break;
    case "app.settings":
      useUIStore.getState().toggleSettings();
      break;
    case "nav.goTasks":
      navigateToLabel("tasks");
      break;
    case "nav.goAttachments":
      navigateToLabel("attachments");
      break;
    case "nav.goTop": {
      if (threads[0]) {
        navigateToThread(threads[0].id);
      }
      break;
    }
    case "nav.escape": {
      if (useComposerStore.getState().isOpen) {
        useComposerStore.getState().closeComposer();
      } else if (useThreadStore.getState().searchThreadIds !== null) {
        const keepSelectedId = getSelectedThreadId();
        if (keepSelectedId) {
          useThreadStore.getState().setFocusThreadIdOnSearchClear(keepSelectedId);
        }
        useThreadStore.getState().clearSearch();
        document.querySelector<HTMLInputElement>('input[aria-label="Search mail"]')?.blur();
      } else if (useThreadStore.getState().selectedThreadIds.size > 0) {
        useThreadStore.getState().clearMultiSelect();
      } else if (selectedId) {
        navigateBack();
      }
      break;
    }
    case "action.compose":
      useComposerStore.getState().openComposer();
      break;
    case "action.reply": {
      if (selectedId) {
        const replyMode = useUIStore.getState().defaultReplyMode;
        window.dispatchEvent(new CustomEvent("sndmail-inline-reply", { detail: { mode: replyMode } }));
      }
      break;
    }
    case "action.replyAll":
      if (selectedId) {
        window.dispatchEvent(new CustomEvent("sndmail-inline-reply", { detail: { mode: "replyAll" } }));
      }
      break;
    case "action.forward":
      if (selectedId) {
        window.dispatchEvent(new CustomEvent("sndmail-inline-reply", { detail: { mode: "forward" } }));
      }
      break;
    case "action.archive": {
      const multiIds = useThreadStore.getState().selectedThreadIds;
      if (multiIds.size > 0 && activeAccountId) {
        const targets = targetsFor(multiIds);
        useThreadStore.getState().clearMultiSelect();
        await runBulkAction(
          targets,
          ({ accountId, threadId }) => archiveThread(accountId, threadId, []),
          { removes: true },
        );
      } else if (selectedId && activeAccountId) {
        await archiveThread(activeAccountId, selectedId, []);
      }
      break;
    }
    case "action.delete": {
      const deleteLabelCtx = getActiveLabel();
      const isTrashView = deleteLabelCtx === "trash";
      const isDraftsView = deleteLabelCtx === "drafts";
      const multiDeleteIds = useThreadStore.getState().selectedThreadIds;
      if (multiDeleteIds.size > 0 && activeAccountId) {
        const targets = targetsFor(multiDeleteIds);
        if (!(await confirmDelete(targets.length, isTrashView))) break;
        useThreadStore.getState().clearMultiSelect();
        await runBulkAction(
          targets,
          async ({ accountId, threadId }) => {
            if (isTrashView) {
              await permanentDeleteThread(accountId, threadId, []);
              await deleteThreadFromDb(accountId, threadId);
            } else if (isDraftsView) {
              const client = await getGmailClient(accountId);
              await deleteDraftsForThread(client, accountId, threadId);
            } else {
              await trashThread(accountId, threadId, []);
            }
          },
          { removes: true },
        );
      } else if (selectedId && activeAccountId) {
        if (isTrashView && !(await confirmDelete(1, true))) break;
        if (isTrashView) {
          await permanentDeleteThread(activeAccountId, selectedId, []);
          await deleteThreadFromDb(activeAccountId, selectedId);
        } else if (isDraftsView) {
          try {
            const client = await getGmailClient(activeAccountId);
            await deleteDraftsForThread(client, activeAccountId, selectedId);
            useThreadStore.getState().removeThread(selectedId);
          } catch (err) {
            console.error("Draft delete failed:", err);
          }
        } else {
          await trashThread(activeAccountId, selectedId, []);
        }
      }
      break;
    }
    case "action.star": {
      if (selectedId && activeAccountId) {
        const thread = threads.find((t) => t.id === selectedId);
        if (thread) {
          await starThread(activeAccountId, selectedId, [], !thread.isStarred);
        }
      }
      break;
    }
    case "action.spam": {
      const isSpamView = getActiveLabel() === "spam";
      const multiSpamIds = useThreadStore.getState().selectedThreadIds;
      if (multiSpamIds.size > 0 && activeAccountId) {
        const ids = [...multiSpamIds];
        for (const id of ids) {
          const acc = accountFor(id);
          if (acc) await spamThread(acc, id, [], !isSpamView);
        }
      } else if (selectedId && activeAccountId) {
        await spamThread(activeAccountId, selectedId, [], !isSpamView);
      }
      break;
    }
    case "action.pin": {
      if (selectedId && activeAccountId) {
        const thread = threads.find((t) => t.id === selectedId);
        if (thread) {
          const newPinned = !thread.isPinned;
          useThreadStore.getState().updateThread(selectedId, { isPinned: newPinned });
          try {
            if (newPinned) {
              await pinThreadDb(activeAccountId, selectedId);
            } else {
              await unpinThreadDb(activeAccountId, selectedId);
            }
          } catch (err) {
            console.error("Pin failed:", err);
            useThreadStore.getState().updateThread(selectedId, { isPinned: !newPinned });
          }
        }
      }
      break;
    }
    case "action.selectAll": {
      useThreadStore.getState().selectAll();
      break;
    }
    case "action.selectFromHere": {
      useThreadStore.getState().selectAllFromHere();
      break;
    }
    case "action.unsubscribe": {
      if (selectedId && activeAccountId) {
        try {
          const msgs = await getMessagesForThread(activeAccountId, selectedId);
          const unsubMsg = msgs.find((m) => m.list_unsubscribe);
          if (unsubMsg) {
            const url = parseUnsubscribeUrl(unsubMsg.list_unsubscribe!);
            if (url) {
              await openUrl(url);
              await archiveThread(activeAccountId, selectedId, []);
            }
          }
        } catch (err) {
          console.error("Unsubscribe failed:", err);
        }
      }
      break;
    }
    case "action.mute": {
      const multiMuteIds = useThreadStore.getState().selectedThreadIds;
      if (multiMuteIds.size > 0 && activeAccountId) {
        const ids = [...multiMuteIds];
        for (const id of ids) {
          const acc = accountFor(id);
          if (!acc) continue;
          const t = threads.find((thread) => thread.id === id);
          if (t?.isMuted) {
            await unmuteThreadDb(acc, id);
            useThreadStore.getState().updateThread(id, { isMuted: false });
          } else {
            await muteThreadDb(acc, id);
            await archiveThread(acc, id, []);
          }
        }
      } else if (selectedId && activeAccountId) {
        const thread = threads.find((t) => t.id === selectedId);
        if (thread) {
          if (thread.isMuted) {
            await unmuteThreadDb(activeAccountId, selectedId);
            useThreadStore.getState().updateThread(selectedId, { isMuted: false });
          } else {
            await muteThreadDb(activeAccountId, selectedId);
            await archiveThread(activeAccountId, selectedId, []);
          }
        }
      }
      break;
    }
    case "action.createTaskFromEmail": {
      if (selectedId) {
        window.dispatchEvent(new CustomEvent("sndmail-extract-task", { detail: { threadId: selectedId } }));
      }
      break;
    }
    case "action.moveToFolder": {
      const multiMoveIds = useThreadStore.getState().selectedThreadIds;
      const moveThreadIds = multiMoveIds.size > 0 ? [...multiMoveIds] : selectedId ? [selectedId] : [];
      if (moveThreadIds.length > 0) {
        window.dispatchEvent(new CustomEvent("sndmail-move-to-folder", { detail: { threadIds: moveThreadIds } }));
      }
      break;
    }
    case "app.commandPalette":
      window.dispatchEvent(new Event("sndmail-toggle-command-palette"));
      break;
    case "app.toggleSidebar":
      useUIStore.getState().toggleSidebar();
      break;
    case "app.askInbox":
      window.dispatchEvent(new Event("sndmail-toggle-ask-inbox"));
      break;
    case "app.help":
      window.dispatchEvent(new Event("sndmail-toggle-shortcuts-help"));
      break;
    case "app.syncFolder": {
      // The unified list shows every mailbox, so refresh all of them
      refreshMail();
      break;
    }
  }
}
