import { create } from "zustand";
import { setSetting } from "@/services/db/settings";
import type { ColorThemeId } from "@/constants/themes";
import { setTimeFormatPreference, type TimeFormat } from "@/utils/date";

type Theme = "light" | "dark" | "system";
type ReadingPanePosition = "right" | "bottom" | "hidden";
type ReadFilter = "all" | "read" | "unread";
export type EmailDensity = "compact" | "default" | "spacious";
export type DefaultReplyMode = "reply" | "replyAll";
export type MarkAsReadBehavior = "instant" | "2s" | "manual";
export type FontScale = "small" | "default" | "large" | "xlarge";
export type InboxViewMode = "unified" | "split";
/**
 * How an open thread is laid out. "classic" stacks messages top to bottom;
 * "chat" turns the thread into a conversation — the user's messages on the
 * right, theirs on the left, quotes and signatures trimmed away.
 */
export type ThreadViewMode = "classic" | "chat";
export type { TimeFormat } from "@/utils/date";
export type SettingsTab =
  | "general"
  | "notifications"
  | "composing"
  | "mail-rules"
  | "people"
  | "accounts"
  | "shortcuts"
  | "ai"
  | "about";

export const SETTINGS_TABS: SettingsTab[] = [
  "general",
  "notifications",
  "composing",
  "mail-rules",
  "people",
  "accounts",
  "shortcuts",
  "ai",
  "about",
];

export function isSettingsTab(value: string | undefined): value is SettingsTab {
  return !!value && (SETTINGS_TABS as string[]).includes(value);
}

export interface SidebarNavItem {
  id: string;
  visible: boolean;
}

interface UIState {
  theme: Theme;
  sidebarCollapsed: boolean;
  contactSidebarVisible: boolean;
  readingPanePosition: ReadingPanePosition;
  readFilter: ReadFilter;
  emailListWidth: number;
  emailDensity: EmailDensity;
  defaultReplyMode: DefaultReplyMode;
  markAsReadBehavior: MarkAsReadBehavior;
  fontScale: FontScale;
  colorTheme: ColorThemeId;
  sendAndArchive: boolean;
  inboxViewMode: InboxViewMode;
  threadViewMode: ThreadViewMode;
  taskSidebarVisible: boolean;
  sidebarNavConfig: SidebarNavItem[] | null;
  reduceMotion: boolean;
  timeFormat: TimeFormat;
  isOnline: boolean;
  pendingOpsCount: number;
  isSyncingFolder: string | null;
  /** Whole-account sync, surfaced as a ring around the account avatar */
  syncState: "idle" | "syncing" | "error";
  syncMessage: string | null;
  /**
   * Contact the sidebar stays on while the user clicks through that person's
   * past conversations. Without it the sidebar would follow each opened
   * thread's sender and the list of conversations would vanish on first click.
   */
  pinnedContact: { email: string; name: string | null } | null;
  settingsOpen: boolean;
  settingsTab: SettingsTab;
  /** Set when something asked for the add-account flow; SettingsPage consumes it */
  settingsAddAccountPending: boolean;
  setTheme: (theme: Theme) => void;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleContactSidebar: () => void;
  setContactSidebarVisible: (visible: boolean) => void;
  setReadingPanePosition: (position: ReadingPanePosition) => void;
  setReadFilter: (filter: ReadFilter) => void;
  setEmailListWidth: (width: number) => void;
  setEmailDensity: (density: EmailDensity) => void;
  setDefaultReplyMode: (mode: DefaultReplyMode) => void;
  setMarkAsReadBehavior: (behavior: MarkAsReadBehavior) => void;
  setFontScale: (scale: FontScale) => void;
  setColorTheme: (theme: ColorThemeId) => void;
  setSendAndArchive: (enabled: boolean) => void;
  setInboxViewMode: (mode: InboxViewMode) => void;
  setThreadViewMode: (mode: ThreadViewMode) => void;
  toggleTaskSidebar: () => void;
  setTaskSidebarVisible: (visible: boolean) => void;
  setSidebarNavConfig: (config: SidebarNavItem[]) => void;
  restoreSidebarNavConfig: (config: SidebarNavItem[]) => void;
  setReduceMotion: (reduce: boolean) => void;
  setTimeFormat: (format: TimeFormat) => void;
  restoreTimeFormat: (format: TimeFormat) => void;
  setOnline: (online: boolean) => void;
  setPendingOpsCount: (count: number) => void;
  setSyncingFolder: (folder: string | null) => void;
  setSyncState: (state: "idle" | "syncing" | "error", message?: string | null) => void;
  pinContact: (contact: { email: string; name: string | null }) => void;
  clearPinnedContact: () => void;
  openSettings: (tab?: string) => void;
  closeSettings: () => void;
  toggleSettings: (tab?: string) => void;
  setSettingsTab: (tab: SettingsTab) => void;
  requestAddAccount: () => void;
  clearAddAccountRequest: () => void;
}

export const useUIStore = create<UIState>((set) => ({
  theme: "system",
  sidebarCollapsed: false,
  contactSidebarVisible: true,
  readingPanePosition: "right",
  readFilter: "all",
  emailListWidth: 420,
  emailDensity: "default",
  defaultReplyMode: "reply",
  markAsReadBehavior: "instant",
  fontScale: "default",
  colorTheme: "indigo",
  sendAndArchive: false,
  inboxViewMode: "unified",
  threadViewMode: "classic",
  // Open the task companion on demand so email remains the primary reading surface.
  taskSidebarVisible: false,
  sidebarNavConfig: null,
  reduceMotion: false,
  timeFormat: "system",
  isOnline: true,
  pendingOpsCount: 0,
  isSyncingFolder: null,
  syncState: "idle",
  syncMessage: null,
  pinnedContact: null,
  settingsOpen: false,
  settingsTab: "general",
  settingsAddAccountPending: false,

  setTheme: (theme) => set({ theme }),
  toggleSidebar: () =>
    set((state) => {
      const collapsed = !state.sidebarCollapsed;
      setSetting("sidebar_collapsed", String(collapsed)).catch(() => {});
      return { sidebarCollapsed: collapsed };
    }),
  setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
  toggleContactSidebar: () =>
    set((state) => {
      const visible = !state.contactSidebarVisible;
      setSetting("details_pane_visible", String(visible)).catch(() => {});
      return { contactSidebarVisible: visible };
    }),
  setContactSidebarVisible: (contactSidebarVisible) => set({ contactSidebarVisible }),
  setReadingPanePosition: (readingPanePosition) => {
    setSetting("reading_pane_position", readingPanePosition).catch(() => {});
    set({ readingPanePosition });
  },
  setReadFilter: (readFilter) => {
    setSetting("read_filter", readFilter).catch(() => {});
    set({ readFilter });
  },
  setEmailListWidth: (emailListWidth) => {
    setSetting("email_list_width", String(emailListWidth)).catch(() => {});
    set({ emailListWidth });
  },
  setEmailDensity: (emailDensity) => {
    setSetting("email_density", emailDensity).catch(() => {});
    set({ emailDensity });
  },
  setDefaultReplyMode: (defaultReplyMode) => {
    setSetting("default_reply_mode", defaultReplyMode).catch(() => {});
    set({ defaultReplyMode });
  },
  setMarkAsReadBehavior: (markAsReadBehavior) => {
    setSetting("mark_as_read_behavior", markAsReadBehavior).catch(() => {});
    set({ markAsReadBehavior });
  },
  setFontScale: (fontScale) => {
    setSetting("font_size", fontScale).catch(() => {});
    set({ fontScale });
  },
  setColorTheme: (colorTheme) => {
    setSetting("color_theme", colorTheme).catch(() => {});
    set({ colorTheme });
  },
  setSendAndArchive: (sendAndArchive) => {
    setSetting("send_and_archive", String(sendAndArchive)).catch(() => {});
    set({ sendAndArchive });
  },
  setInboxViewMode: (inboxViewMode) => {
    setSetting("inbox_view_mode", inboxViewMode).catch(() => {});
    set({ inboxViewMode });
  },
  setThreadViewMode: (threadViewMode) => {
    setSetting("thread_view_mode", threadViewMode).catch(() => {});
    set({ threadViewMode });
  },
  toggleTaskSidebar: () =>
    set((state) => {
      const visible = !state.taskSidebarVisible;
      setSetting("task_sidebar_visible", String(visible)).catch(() => {});
      return { taskSidebarVisible: visible };
    }),
  setTaskSidebarVisible: (taskSidebarVisible) => set({ taskSidebarVisible }),
  setSidebarNavConfig: (sidebarNavConfig) => {
    setSetting("sidebar_nav_config", JSON.stringify(sidebarNavConfig)).catch(() => {});
    set({ sidebarNavConfig });
  },
  restoreSidebarNavConfig: (sidebarNavConfig) => set({ sidebarNavConfig }),
  setReduceMotion: (reduceMotion) => {
    setSetting("reduce_motion", String(reduceMotion)).catch(() => {});
    set({ reduceMotion });
  },
  setTimeFormat: (timeFormat) => {
    setSetting("time_format", timeFormat).catch(() => {});
    setTimeFormatPreference(timeFormat);
    set({ timeFormat });
  },
  /** Apply a persisted value on startup without writing it back. */
  restoreTimeFormat: (timeFormat) => {
    setTimeFormatPreference(timeFormat);
    set({ timeFormat });
  },
  setOnline: (isOnline) => set({ isOnline }),
  setPendingOpsCount: (pendingOpsCount) => set({ pendingOpsCount }),
  setSyncingFolder: (isSyncingFolder) => set({ isSyncingFolder }),
  setSyncState: (syncState, syncMessage = null) => set({ syncState, syncMessage }),
  pinContact: (pinnedContact) => set({ pinnedContact }),
  clearPinnedContact: () => set({ pinnedContact: null }),
  openSettings: (tab) =>
    set(isSettingsTab(tab) ? { settingsOpen: true, settingsTab: tab } : { settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
  toggleSettings: (tab) =>
    set((state) => {
      if (state.settingsOpen) return { settingsOpen: false };
      return isSettingsTab(tab)
        ? { settingsOpen: true, settingsTab: tab }
        : { settingsOpen: true };
    }),
  setSettingsTab: (settingsTab) => set({ settingsTab }),
  requestAddAccount: () =>
    set({ settingsOpen: true, settingsTab: "accounts", settingsAddAccountPending: true }),
  clearAddAccountRequest: () => set({ settingsAddAccountPending: false }),
}));
