import { useEffect, useState, useCallback, useRef } from "react";
import { Outlet } from "@tanstack/react-router";
import { Sidebar } from "./components/layout/Sidebar";
import { AddAccount } from "./components/accounts/AddAccount";
import { Composer } from "./components/composer/Composer";
import { UndoSendToast } from "./components/composer/UndoSendToast";
import { CommandPalette } from "./components/search/CommandPalette";
import { ShortcutsHelp } from "./components/search/ShortcutsHelp";
import { AskInbox } from "./components/search/AskInbox";
import { useUIStore } from "./stores/uiStore";
import { useAccountStore } from "./stores/accountStore";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { runMigrations } from "./services/db/migrations";
import { getAllAccounts } from "./services/db/accounts";
import { getSetting } from "./services/db/settings";
import {
  startInitialSync,
  triggerSync,
  onSyncStatus,
  onSyncBatchComplete,
} from "./services/gmail/syncManager";
import { startGmailPushRelay, stopGmailPushRelay } from "./services/gmail/gmailPushRelay";
import { initializeClients } from "./services/gmail/tokenManager";
import {
  startSnoozeChecker,
  stopSnoozeChecker,
} from "./services/snooze/snoozeManager";
import {
  startScheduledSendChecker,
  stopScheduledSendChecker,
} from "./services/snooze/scheduledSendManager";
import {
  startFollowUpChecker,
  stopFollowUpChecker,
} from "./services/followup/followupManager";
import {
  startBundleChecker,
  stopBundleChecker,
} from "./services/bundles/bundleManager";
import { initNotifications } from "./services/notifications/notificationManager";
import {
  initGlobalShortcut,
  unregisterComposeShortcut,
} from "./services/globalShortcut";
import { initDeepLinkHandler } from "./services/deepLinkHandler";
import { initScrollbarVisibility } from "./utils/scrollbars";
import { updateBadgeCount } from "./services/badgeManager";
import {
  startQueueProcessor,
  stopQueueProcessor,
  triggerQueueFlush,
} from "./services/queue/queueProcessor";
import {
  startPreCacheManager,
  stopPreCacheManager,
} from "./services/attachments/preCacheManager";
import {
  startUpdateChecker,
  stopUpdateChecker,
} from "./services/updateManager";
import { fetchSendAsAliases } from "./services/gmail/sendAs";
import { refreshAfterAccountAdded } from "./services/accounts/accountLifecycle";
import { startSemanticSearchStatusObserver } from "./services/search/semanticSearchRuntime";

/** How often a long initial sync pushes what it has stored so far to the UI. */
const INCREMENTAL_REFRESH_MS = 1_500;
import { SettingsDialog } from "./components/settings/SettingsDialog";
import { getGmailClient } from "./services/gmail/tokenManager";
import { invoke } from "@tauri-apps/api/core";
import { DndProvider } from "./components/dnd/DndProvider";
import { WorkspaceToolbar } from "./components/layout/WorkspaceToolbar";
import { useShortcutStore } from "./stores/shortcutStore";
import { getIncompleteTaskCount } from "./services/db/tasks";
import { useTaskStore } from "./stores/taskStore";
import { ContextMenuPortal } from "./components/ui/ContextMenuPortal";
import { MoveToFolderDialog } from "./components/email/MoveToFolderDialog";
import { OfflineBanner } from "./components/ui/OfflineBanner";
import { ToastHost } from "./components/ui/ToastHost";
import { reportError } from "./stores/toastStore";
import { UpdateToast } from "./components/ui/UpdateToast";
import { ErrorBoundary } from "./components/ui/ErrorBoundary";
import { formatSyncError } from "./utils/networkErrors";
import { getThemeById, COLOR_THEMES } from "./constants/themes";
import type { ColorThemeId } from "./constants/themes";
import { router } from "./router";
import { getSelectedThreadId } from "./router/navigate";

/**
 * Sync bridge: subscribes to router state changes and writes the selected
 * thread ID to the threadStore so that range-select and other multi-select
 * logic can use it as an anchor.
 */
function useRouterSyncBridge() {
  useEffect(() => {
    return router.subscribe("onResolved", () => {
      const threadId = getSelectedThreadId();
      if (useThreadStore.getState().selectedThreadId !== threadId) {
        useThreadStore.getState().selectThread(threadId);
      }
    });
  }, []);
}

import { useThreadStore } from "./stores/threadStore";

export default function App() {
  const theme = useUIStore((s) => s.theme);
  const fontScale = useUIStore((s) => s.fontScale);
  const colorTheme = useUIStore((s) => s.colorTheme);
  const reduceMotion = useUIStore((s) => s.reduceMotion);
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed);
  const [showAddAccount, setShowAddAccount] = useState(false);
  // Throttles the "show what has synced so far" refresh during a long initial sync
  const lastIncrementalRefreshRef = useRef(0);
  const [initialized, setInitialized] = useState(false);
  // Sync progress is shown as a ring around the account avatar in the sidebar
  const setSyncState = useUIStore((s) => s.setSyncState);
  const setSyncStatus = useCallback(
    (message: string | null) => {
      if (message === null) {
        setSyncState("idle", null);
      } else if (message.startsWith("Sync failed")) {
        setSyncState("error", message);
        // The ring around the avatar turns red, which is easy to miss. Say it.
        reportError("Sync failed", message.replace(/^Sync failed:?\s*/, ""), {
          label: "Retry",
          run: () => import("@/services/refreshMail").then((m) => m.refreshMail()),
        });
      } else {
        setSyncState("syncing", message);
      }
    },
    [setSyncState],
  );
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [showShortcutsHelp, setShowShortcutsHelp] = useState(false);
  const [showAskInbox, setShowAskInbox] = useState(false);
  const [moveToFolderState, setMoveToFolderState] = useState<{ open: boolean; threadIds: string[] }>({ open: false, threadIds: [] });
  const deepLinkCleanupRef = useRef<(() => void) | undefined>(undefined);

  // Sync bridge: router state → Zustand stores (temporary)
  useRouterSyncBridge();

  // Register global keyboard shortcuts
  useKeyboardShortcuts();

  // Network status detection
  useEffect(() => {
    const { setOnline } = useUIStore.getState();
    setOnline(navigator.onLine);

    const handleOnline = () => {
      setOnline(true);
      triggerQueueFlush();
      const accounts = useAccountStore.getState().accounts;
      const activeIds = accounts.filter((a) => a.isActive && a.provider !== "caldav").map((a) => a.id);
      if (activeIds.length > 0) triggerSync(activeIds);
    };
    const handleOffline = () => setOnline(false);

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  // Scrollbars show while a pane is being scrolled, then fade out again
  useEffect(() => initScrollbarVisibility(), []);

  // Observe native autoresume and background failures even with Settings closed.
  useEffect(() => startSemanticSearchStatusObserver(), []);

  // Suppress default browser context menu globally (Tauri app should feel native)
  // Elements with data-native-context-menu opt out so the browser menu is available
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest?.("[data-native-context-menu]")) return;
      e.preventDefault();
    };
    document.addEventListener("contextmenu", handler);
    return () => document.removeEventListener("contextmenu", handler);
  }, []);

  // Listen for command palette / shortcuts help toggle events
  useEffect(() => {
    const togglePalette = () => setShowCommandPalette((p) => !p);
    const toggleHelp = () => setShowShortcutsHelp((p) => !p);
    const toggleAskInbox = () => setShowAskInbox((p) => !p);
    const handleMoveToFolder = (e: Event) => {
      const detail = (e as CustomEvent<{ threadIds: string[] }>).detail;
      setMoveToFolderState({ open: true, threadIds: detail.threadIds });
    };
    window.addEventListener("snd-toggle-command-palette", togglePalette);
    window.addEventListener("snd-toggle-shortcuts-help", toggleHelp);
    window.addEventListener("snd-toggle-ask-inbox", toggleAskInbox);
    // A sign-in link opened from a notification goes past the phishing check
    // rather than straight to the browser — a link in mail is the vector
    const handleSignInLink = async (e: Event) => {
      const detail = (e as CustomEvent).detail as { url?: string } | undefined;
      if (!detail?.url) return;
      try {
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(detail.url);
      } catch (err) {
        console.error("Failed to open the sign-in link:", err);
      }
    };
    // A server said something changed: run that account's sync now
    const handleIdleSync = (e: Event) => {
      const detail = (e as CustomEvent).detail as { accountId?: string } | undefined;
      if (!detail?.accountId) return;
      import("@/services/gmail/syncManager")
        .then(({ syncAccount }) => syncAccount(detail.accountId!))
        .catch((err) => console.error("Sync after IDLE failed:", err));
    };
    window.addEventListener("snd-idle-sync", handleIdleSync);

    // Anything nobody caught. Not a substitute for catching things — the
    // message is whatever the browser gives us — but it means an error can no
    // longer vanish into a console the user is not looking at.
    const handleUncaught = (e: ErrorEvent) => {
      reportError("Something went wrong", e.error ?? e.message);
    };
    const handleRejection = (e: PromiseRejectionEvent) => {
      reportError("Something went wrong", e.reason);
    };
    window.addEventListener("error", handleUncaught);
    window.addEventListener("unhandledrejection", handleRejection);

    window.addEventListener("snd-open-signin-link", handleSignInLink);

    window.addEventListener("snd-move-to-folder", handleMoveToFolder);
    return () => {
      window.removeEventListener("snd-toggle-command-palette", togglePalette);
      window.removeEventListener("snd-toggle-shortcuts-help", toggleHelp);
      window.removeEventListener("snd-toggle-ask-inbox", toggleAskInbox);
      window.removeEventListener("snd-idle-sync", handleIdleSync);
      window.removeEventListener("error", handleUncaught);
      window.removeEventListener("unhandledrejection", handleRejection);
      window.removeEventListener("snd-open-signin-link", handleSignInLink);
      window.removeEventListener("snd-move-to-folder", handleMoveToFolder);
    };
  }, []);

  // Listen for tray "Check for Mail" button
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    import("@tauri-apps/api/event").then(({ listen }) => {
      listen("tray-check-mail", () => {
        const accounts = useAccountStore.getState().accounts;
        const activeIds = accounts.filter((a) => a.isActive && a.provider !== "caldav").map((a) => a.id);
        if (activeIds.length > 0) {
          triggerSync(activeIds);
        }
      }).then((fn) => { unlisten = fn; });
    });
    return () => { unlisten?.(); };
  }, []);

  // Initialize database, load accounts, start sync
  useEffect(() => {
    async function init() {
      try {
        try {
          await runMigrations();
        } catch (err) {
          // Without the schema nothing below can load. Say why, instead of
          // presenting an empty app that looks like lost data.
          reportError("Database update failed — the app cannot start properly", err);
          throw err;
        }

        const ui = useUIStore.getState();

        // Restore persisted theme
        const savedTheme = await getSetting("theme");
        if (savedTheme === "light" || savedTheme === "dark" || savedTheme === "system") {
          ui.setTheme(savedTheme);
        }

        // Restore persisted sidebar state
        const savedSidebar = await getSetting("sidebar_collapsed");
        if (savedSidebar === "true" || savedSidebar === "false") {
          ui.setSidebarCollapsed(savedSidebar === "true");
        }

        // Restore contact sidebar visibility
        const savedContactSidebar = await getSetting("contact_sidebar_visible");
        if (savedContactSidebar === "false") {
          ui.setContactSidebarVisible(false);
        }

        // Restore reading pane position
        const savedPanePos = await getSetting("reading_pane_position");
        if (savedPanePos === "right" || savedPanePos === "bottom" || savedPanePos === "hidden") {
          ui.setReadingPanePosition(savedPanePos);
        }

        // Restore read filter
        const savedReadFilter = await getSetting("read_filter");
        if (savedReadFilter === "all" || savedReadFilter === "read" || savedReadFilter === "unread") {
          ui.setReadFilter(savedReadFilter);
        }

        // Restore email list width
        const savedListWidth = await getSetting("email_list_width");
        if (savedListWidth) {
          const w = parseInt(savedListWidth, 10);
          if (w >= 240 && w <= 800) ui.setEmailListWidth(w);
        }

        // Restore email density
        const savedDensity = await getSetting("email_density");
        if (savedDensity === "compact" || savedDensity === "default" || savedDensity === "spacious") {
          ui.setEmailDensity(savedDensity);
        }

        // Restore thread view mode (classic list vs chat bubbles)
        const savedThreadView = await getSetting("thread_view_mode");
        if (savedThreadView === "classic" || savedThreadView === "chat") {
          ui.setThreadViewMode(savedThreadView);
        }

        // Restore default reply mode
        const savedReplyMode = await getSetting("default_reply_mode");
        if (savedReplyMode === "reply" || savedReplyMode === "replyAll") {
          ui.setDefaultReplyMode(savedReplyMode);
        }

        // Restore mark-as-read behavior
        const savedMarkRead = await getSetting("mark_as_read_behavior");
        if (savedMarkRead === "instant" || savedMarkRead === "2s" || savedMarkRead === "manual") {
          ui.setMarkAsReadBehavior(savedMarkRead);
        }

        // Restore send and archive
        const savedSendArchive = await getSetting("send_and_archive");
        if (savedSendArchive === "true") {
          ui.setSendAndArchive(true);
        }

        // Restore font scale
        const savedFontScale = await getSetting("font_size");
        if (savedFontScale === "small" || savedFontScale === "default" || savedFontScale === "large" || savedFontScale === "xlarge") {
          ui.setFontScale(savedFontScale);
        }

        // Restore color theme
        const savedColorTheme = await getSetting("color_theme");
        if (savedColorTheme && COLOR_THEMES.some((t) => t.id === savedColorTheme)) {
          ui.setColorTheme(savedColorTheme as ColorThemeId);
        }

        // Restore inbox view mode
        const savedViewMode = await getSetting("inbox_view_mode");
        if (savedViewMode === "unified" || savedViewMode === "split") {
          ui.setInboxViewMode(savedViewMode);
        }

        // Restore reduce motion preference
        const savedReduceMotion = await getSetting("reduce_motion");
        if (savedReduceMotion === "true") {
          ui.setReduceMotion(true);
        }

        const savedTimeFormat = await getSetting("time_format");
        if (savedTimeFormat === "12h" || savedTimeFormat === "24h") {
          ui.restoreTimeFormat(savedTimeFormat);
        }

        // Restore task sidebar visibility
        const savedTaskSidebar = await getSetting("task_sidebar_visible");
        if (savedTaskSidebar === "true") {
          ui.setTaskSidebarVisible(true);
        }

        // Restore sidebar nav config
        const savedNavConfig = await getSetting("sidebar_nav_config");
        if (savedNavConfig) {
          try {
            const parsed = JSON.parse(savedNavConfig);
            if (Array.isArray(parsed)) ui.restoreSidebarNavConfig(parsed);
          } catch { /* ignore malformed JSON */ }
        }

        // Load custom keyboard shortcuts
        await useShortcutStore.getState().loadKeyMap();

        const dbAccounts = await getAllAccounts();
        const mapped = dbAccounts.map((a) => ({
          id: a.id,
          email: a.email,
          displayName: a.display_name,
          avatarUrl: a.avatar_url,
          isActive: a.is_active === 1,
          provider: a.provider,
          color: a.color,
        }));
        const savedAccountId = await getSetting("active_account_id");
        useAccountStore.getState().setAccounts(mapped, savedAccountId);

        // Restore the unified inbox choice, but only while it still applies
        const savedCalendarAccount = await getSetting("calendar_account_id");
        if (savedCalendarAccount) {
          useAccountStore.getState().restoreCalendarAccountId(savedCalendarAccount);
        }

        const savedAlias = await getSetting("active_alias_email");
        if (savedAlias) {
          useAccountStore.getState().restoreActiveIdentity(savedAlias);
        }

        const savedUnified = await getSetting("unified_inbox");
        if (savedUnified === "true") {
          const mailboxes = mapped.filter((a) => a.provider !== "caldav");
          if (mailboxes.length > 1) {
            useAccountStore.getState().restoreUnifiedInbox(true);
          }
        }

        // Initialize Gmail clients for existing accounts
        await initializeClients();

        // Fetch send-as aliases for each active email account (skip CalDAV-only)
        const emailAccountIds = mapped.filter((a) => a.isActive && a.provider !== "caldav").map((a) => a.id);
        for (const accountId of emailAccountIds) {
          try {
            const client = await getGmailClient(accountId);
            await fetchSendAsAliases(client, accountId);
          } catch (err) {
            console.warn(`Failed to fetch send-as aliases for ${accountId}:`, err);
          }
        }

        // Catch up once, then let Gmail push / IMAP IDLE drive mail updates.
        if (emailAccountIds.length > 0) {
          startInitialSync(emailAccountIds);
          void startGmailPushRelay();

          // Let the servers say when something changed.
          const { startIdleWatchers } = await import("@/services/imap/idleManager");
          startIdleWatchers().catch((err) => {
            console.warn("Could not start IDLE watchers:", err);
          });
        }

        // Start snooze, scheduled send, follow-up, bundle, and queue checkers
        startSnoozeChecker();
        startScheduledSendChecker();
        startFollowUpChecker();
        startBundleChecker();
        startQueueProcessor();
        startPreCacheManager();

        // Initialize notifications. Not awaited: on a bundled macOS build the
        // first run shows the system permission prompt, and the rest of
        // start-up (and the splash screen) must not wait on the user's answer
        void initNotifications();

        // Initialize global compose shortcut
        await initGlobalShortcut();

        // Initialize deep link handler
        deepLinkCleanupRef.current = await initDeepLinkHandler();

        // Initial badge count
        await updateBadgeCount();

        // Load initial task count
        const activeAcct = useAccountStore.getState().activeAccountId;
        if (activeAcct) {
          const count = await getIncompleteTaskCount(activeAcct);
          useTaskStore.getState().setIncompleteCount(count);
        }

        // Start auto-update checker
        startUpdateChecker();
      } catch (err) {
        console.error("Failed to initialize:", err);
      }
      setInitialized(true);
      invoke("close_splashscreen").catch(() => {});
    }

    init();

    return () => {
      stopGmailPushRelay();
      import("@/services/imap/idleManager")
        .then(({ stopIdleWatchers }) => stopIdleWatchers())
        .catch(() => { /* shutting down anyway */ });
      stopSnoozeChecker();
      stopScheduledSendChecker();
      stopFollowUpChecker();
      stopBundleChecker();
      stopQueueProcessor();
      stopPreCacheManager();
      stopUpdateChecker();
      unregisterComposeShortcut();
      deepLinkCleanupRef.current?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- store setters are stable references
  }, []);

  // Listen for sync status updates
  const backfillDoneRef = useRef(false);
  useEffect(() => {
    const unsubStatus = onSyncStatus((_accountId, status, progress, error) => {
      if (status === "syncing") {
        if (progress) {
          if (progress.phase === "messages") {
            setSyncStatus(
              `Syncing: ${progress.current}/${progress.total} messages`,
            );
            // Threads are written to the DB as they arrive, so show them as they
            // land instead of leaving the list empty until the whole sync ends.
            // A separate event from snd-sync-done: this one must not disturb an
            // active search or a scrolled-in page.
            const now = Date.now();
            if (now - lastIncrementalRefreshRef.current > INCREMENTAL_REFRESH_MS) {
              lastIncrementalRefreshRef.current = now;
              window.dispatchEvent(new Event("snd-sync-progress"));
            }
          } else if (progress.phase === "labels") {
            setSyncStatus("Syncing labels...");
          } else if (progress.phase === "threads") {
            setSyncStatus(`Building threads... (${progress.current}/${progress.total})`);
          }
        } else {
          setSyncStatus("Syncing...");
        }
      } else if (status === "error") {
        lastIncrementalRefreshRef.current = 0;
        setSyncStatus(error ? `Sync failed: ${formatSyncError(error)}` : "Sync failed");
        // Auto-clear the error after 8 seconds
        setTimeout(() => setSyncStatus(null), 8_000);
      }
    });
    const unsubBatch = onSyncBatchComplete(({ accountIds, failedAccountIds }) => {
      lastIncrementalRefreshRef.current = 0;
      if (failedAccountIds.length === 0) {
        setSyncStatus("Sync complete");
        setTimeout(() => setSyncStatus(null), 2_000);
      }
      // One store/list refresh for the whole mailbox batch, never one per account.
      window.dispatchEvent(new Event("snd-sync-done"));
      void updateBadgeCount();

      // Keep post-sync categorization out of the per-mailbox loop and start it
      // only after the complete batch has released the mail sync pipeline.
      if (!backfillDoneRef.current) {
        const successfulAccountId = accountIds.find(
          (accountId) => !failedAccountIds.includes(accountId),
        );
        if (successfulAccountId) {
          backfillDoneRef.current = true;
          import("./services/categorization/backfillService")
            .then(({ backfillUncategorizedThreads }) =>
              backfillUncategorizedThreads(successfulAccountId),
            )
            .catch((err) => console.error("Backfill error:", err));
        }
      }
    });
    return () => {
      unsubStatus();
      unsubBatch();
    };
  }, []);

  // Sync theme class to <html> element
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "dark") {
      root.classList.add("dark");
    } else if (theme === "light") {
      root.classList.remove("dark");
    } else {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const apply = () => {
        if (mq.matches) {
          root.classList.add("dark");
        } else {
          root.classList.remove("dark");
        }
      };
      apply();
      mq.addEventListener("change", apply);
      return () => mq.removeEventListener("change", apply);
    }
  }, [theme]);

  // Sync font-scale class to <html> element
  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove("font-scale-small", "font-scale-default", "font-scale-large", "font-scale-xlarge");
    root.classList.add(`font-scale-${fontScale}`);
  }, [fontScale]);

  // Sync reduce-motion class to <html> element
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("reduce-motion", reduceMotion);
  }, [reduceMotion]);

  // Apply color theme CSS custom properties to <html>
  useEffect(() => {
    const root = document.documentElement;
    const props = ["--color-accent", "--color-accent-hover", "--color-accent-light", "--color-bg-selected", "--color-sidebar-active"];

    const apply = () => {
      if (colorTheme === "indigo") {
        // Default theme — remove inline overrides, let CSS handle it
        for (const p of props) root.style.removeProperty(p);
        return;
      }
      const themeData = getThemeById(colorTheme);
      const isDark =
        theme === "dark" ||
        (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
      const colors = isDark ? themeData.dark : themeData.light;
      root.style.setProperty("--color-accent", colors.accent);
      root.style.setProperty("--color-accent-hover", colors.accentHover);
      root.style.setProperty("--color-accent-light", colors.accentLight);
      root.style.setProperty("--color-bg-selected", colors.bgSelected);
      root.style.setProperty("--color-sidebar-active", colors.sidebarActive);
    };

    apply();

    if (theme === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      mq.addEventListener("change", apply);
      return () => mq.removeEventListener("change", apply);
    }
  }, [colorTheme, theme]);

  const handleAddAccountSuccess = useCallback(async () => {
    setShowAddAccount(false);
    await refreshAfterAccountAdded();
  }, []);

  if (!initialized) {
    return (
      <div className="flex h-screen items-center justify-center bg-bg-primary">
        <div className="flex flex-col items-center gap-4">
          <div className="relative w-10 h-10">
            <div className="absolute inset-0 rounded-full border-2 border-accent/20" />
            <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-accent animate-spin" />
          </div>
          <span className="text-xs text-text-tertiary animate-pulse">Loading your inbox...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="app-workspace relative flex h-screen flex-col overflow-hidden rounded-[1.75rem] text-text-primary">
      <OfflineBanner />
      <ToastHost />
      <DndProvider>
        <WorkspaceToolbar onAddAccount={() => setShowAddAccount(true)} />
        <div className="canvas-shell flex flex-1 min-w-0 overflow-hidden">
          <ErrorBoundary name="Sidebar">
            <Sidebar collapsed={sidebarCollapsed} />
          </ErrorBoundary>
          <Outlet />
        </div>
      </DndProvider>

      {showAddAccount && (
        <AddAccount
          onClose={() => setShowAddAccount(false)}
          onSuccess={handleAddAccountSuccess}
        />
      )}

      <SettingsDialog />

      <ErrorBoundary name="Composer">
        <Composer />
      </ErrorBoundary>
      <UndoSendToast />
      <UpdateToast />
      <ErrorBoundary name="CommandPalette">
        <CommandPalette
          isOpen={showCommandPalette}
          onClose={() => setShowCommandPalette(false)}
        />
      </ErrorBoundary>
      <ShortcutsHelp
        isOpen={showShortcutsHelp}
        onClose={() => setShowShortcutsHelp(false)}
      />
      <ErrorBoundary name="AskInbox">
        <AskInbox
          isOpen={showAskInbox}
          onClose={() => setShowAskInbox(false)}
        />
      </ErrorBoundary>
      <ContextMenuPortal />
      <MoveToFolderDialog
        isOpen={moveToFolderState.open}
        threadIds={moveToFolderState.threadIds}
        onClose={() => setMoveToFolderState({ open: false, threadIds: [] })}
      />
    </div>
  );
}
