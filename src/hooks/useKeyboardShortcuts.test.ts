import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies needed for the hook to mount and dispatch events.
// The hook reads store state and calls navigate/emailActions — only mock
// what's needed for the three event-dispatch tests below.
const uiState = {
  inboxViewMode: "unified",
  settingsOpen: false,
  toggleSidebar: vi.fn(),
  toggleSettings: vi.fn(() => {
    uiState.settingsOpen = !uiState.settingsOpen;
  }),
};
vi.mock("@/stores/uiStore", () => ({
  useUIStore: { getState: () => uiState },
}));
const threadState = {
  threads: [],
  selectedThreadIds: new Set(),
  removeThread: vi.fn(),
  removeThreads: vi.fn(),
  updateThread: vi.fn(),
  clearMultiSelect: vi.fn(),
  selectAll: vi.fn(),
  selectAllFromHere: vi.fn(),
};
vi.mock("@/stores/threadStore", () => ({
  useThreadStore: { getState: () => threadState },
}));
const composerState = {
  isOpen: false,
  openComposer: vi.fn(),
  closeComposer: vi.fn(),
};
const defaultKeyMap = {
  "app.askInbox": "i",
  "app.commandPalette": "/",
  "app.toggleSidebar": "Ctrl+Shift+E",
  "app.settings": "Ctrl+,",
  "app.help": "?",
  "action.selectAll": "Ctrl+A",
  "action.archive": "e",
  "nav.escape": "Escape",
};
let shortcutKeyMap = { ...defaultKeyMap };
vi.mock("@/stores/composerStore", () => ({
  useComposerStore: { getState: () => composerState },
}));
vi.mock("@/stores/accountStore", () => ({
  useAccountStore: { getState: () => ({ activeAccountId: null }) },
}));
vi.mock("@/stores/shortcutStore", () => ({
  useShortcutStore: {
    getState: () => ({
      keyMap: shortcutKeyMap,
    }),
  },
}));
vi.mock("@/stores/contextMenuStore", () => ({
  useContextMenuStore: { getState: () => ({ menuType: null, closeMenu: vi.fn() }) },
}));
vi.mock("@/router/navigate", () => ({
  navigateToLabel: vi.fn(),
  navigateToThread: vi.fn(),
  navigateBack: vi.fn(),
  getActiveLabel: () => "inbox",
  getSelectedThreadId: () => null,
}));
vi.mock("@/services/emailActions", () => ({
  archiveThread: vi.fn(),
  trashThread: vi.fn(),
  permanentDeleteThread: vi.fn(),
  starThread: vi.fn(),
  spamThread: vi.fn(),
}));
vi.mock("@/services/db/threads", () => ({
  deleteThread: vi.fn(),
  pinThread: vi.fn(),
  unpinThread: vi.fn(),
  muteThread: vi.fn(),
  unmuteThread: vi.fn(),
}));
vi.mock("@/services/gmail/draftDeletion", () => ({ deleteDraftsForThread: vi.fn() }));
vi.mock("@/services/gmail/tokenManager", () => ({ getGmailClient: vi.fn() }));
vi.mock("@/services/db/messages", () => ({ getMessagesForThread: vi.fn() }));
vi.mock("@/components/email/MessageItem", () => ({ parseUnsubscribeUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@/services/gmail/syncManager", () => ({ triggerSync: vi.fn() }));

import { renderHook } from "@testing-library/react";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";

describe("useKeyboardShortcuts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    uiState.settingsOpen = false;
    composerState.isOpen = false;
    shortcutKeyMap = { ...defaultKeyMap };
  });

  it("dispatches snd-toggle-ask-inbox when 'i' is pressed", () => {
    renderHook(() => useKeyboardShortcuts());

    const listener = vi.fn();
    window.addEventListener("snd-toggle-ask-inbox", listener);

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "i", bubbles: true }),
    );

    expect(listener).toHaveBeenCalledTimes(1);

    window.removeEventListener("snd-toggle-ask-inbox", listener);
  });

  it("dispatches an action rebound to Cmd+Shift+letter", () => {
    shortcutKeyMap = { ...defaultKeyMap, "app.askInbox": "Cmd+Shift+I" };
    renderHook(() => useKeyboardShortcuts());

    const listener = vi.fn();
    window.addEventListener("snd-toggle-ask-inbox", listener);

    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "i",
      metaKey: true,
      shiftKey: true,
      bubbles: true,
    }));

    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener("snd-toggle-ask-inbox", listener);
  });

  it("dispatches an action rebound to an Alt combination", () => {
    shortcutKeyMap = { ...defaultKeyMap, "app.askInbox": "Alt+I" };
    renderHook(() => useKeyboardShortcuts());

    const listener = vi.fn();
    window.addEventListener("snd-toggle-ask-inbox", listener);

    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "i",
      altKey: true,
      bubbles: true,
    }));

    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener("snd-toggle-ask-inbox", listener);
  });

  it("dispatches snd-toggle-command-palette when '/' is pressed", () => {
    renderHook(() => useKeyboardShortcuts());

    const listener = vi.fn();
    window.addEventListener("snd-toggle-command-palette", listener);

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "/", bubbles: true }),
    );

    expect(listener).toHaveBeenCalledTimes(1);

    window.removeEventListener("snd-toggle-command-palette", listener);
  });

  it("dispatches snd-toggle-shortcuts-help when '?' is pressed", () => {
    renderHook(() => useKeyboardShortcuts());

    const listener = vi.fn();
    window.addEventListener("snd-toggle-shortcuts-help", listener);

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "?", shiftKey: true, bubbles: true }),
    );

    expect(listener).toHaveBeenCalledTimes(1);

    window.removeEventListener("snd-toggle-shortcuts-help", listener);
  });

  it("toggles the settings dialog on Ctrl+,", () => {
    renderHook(() => useKeyboardShortcuts());

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: ",", ctrlKey: true, bubbles: true }),
    );

    expect(uiState.toggleSettings).toHaveBeenCalledTimes(1);
    expect(uiState.settingsOpen).toBe(true);
  });

  it("toggles the settings dialog on Cmd+, (meta key)", () => {
    renderHook(() => useKeyboardShortcuts());

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: ",", metaKey: true, bubbles: true }),
    );

    expect(uiState.toggleSettings).toHaveBeenCalledTimes(1);
  });

  it("closes the settings dialog when the binding is pressed again", () => {
    uiState.settingsOpen = true;
    renderHook(() => useKeyboardShortcuts());

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: ",", metaKey: true, bubbles: true }),
    );

    expect(uiState.toggleSettings).toHaveBeenCalledTimes(1);
    expect(uiState.settingsOpen).toBe(false);
  });

  it("suppresses mail shortcuts while the settings dialog is open", () => {
    uiState.settingsOpen = true;
    renderHook(() => useKeyboardShortcuts());

    const listener = vi.fn();
    window.addEventListener("snd-toggle-ask-inbox", listener);

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "i", bubbles: true }),
    );

    expect(listener).not.toHaveBeenCalled();

    window.removeEventListener("snd-toggle-ask-inbox", listener);
  });

  it("selects every thread on Ctrl+A in the mail list", () => {
    renderHook(() => useKeyboardShortcuts());

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true }),
    );

    expect(threadState.selectAll).toHaveBeenCalledTimes(1);
  });

  it("leaves Ctrl+A alone while the composer is open", () => {
    // The message being written is what "select all" means there — this once
    // selected every thread behind the composer instead
    composerState.isOpen = true;
    renderHook(() => useKeyboardShortcuts());

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "a", metaKey: true, bubbles: true }),
    );

    expect(threadState.selectAll).not.toHaveBeenCalled();
  });

  it("leaves Ctrl+A alone while typing in an input", () => {
    renderHook(() => useKeyboardShortcuts());

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "a", metaKey: true, bubbles: true }),
    );

    expect(threadState.selectAll).not.toHaveBeenCalled();
    input.remove();
  });

  it("suppresses mail shortcuts while the composer is open", () => {
    composerState.isOpen = true;
    renderHook(() => useKeyboardShortcuts());

    const listener = vi.fn();
    window.addEventListener("snd-toggle-ask-inbox", listener);

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "i", bubbles: true }),
    );

    expect(listener).not.toHaveBeenCalled();

    window.removeEventListener("snd-toggle-ask-inbox", listener);
  });

  it("still closes the composer on Escape", () => {
    composerState.isOpen = true;
    renderHook(() => useKeyboardShortcuts());

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );

    expect(composerState.closeComposer).toHaveBeenCalledTimes(1);
  });
});
