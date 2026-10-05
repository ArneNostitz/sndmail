import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useUIStore, type SettingsTab } from "@/stores/uiStore";
import { useIdleStatusStore, describeIdleState, explainIdleFailure } from "@/stores/idleStatusStore";
import { Tooltip } from "@/components/ui/Tooltip";
import { reportError, notify } from "@/stores/toastStore";
import { Spinner } from "@/components/ui/Spinner";
import { useAccountStore } from "@/stores/accountStore";
import { useComposerStore } from "@/stores/composerStore";
import { getSetting, setSetting, getSecureSetting, setSecureSetting } from "@/services/db/settings";
import { getDb } from "@/services/db/connection";
import {
  getNotificationBackend,
  getNativeNotificationFailure,
  applyNotificationsEnabled,
  sendTestNotification,
  type NotificationBackend,
} from "@/services/notifications/notificationManager";
import { PROVIDER_MODELS, resolveModelId } from "@/services/ai/types";
import { FIX_NUMBER } from "@/constants/build";
import { UPDATE_SOURCE_CONFIGURED } from "@/services/updateManager";
import { deleteAccount, updateAccountColor } from "@/services/db/accounts";
import { ACCOUNT_COLORS, accountColor } from "@/constants/accountColors";
import { removeClient, reauthorizeAccount, getGmailClient } from "@/services/gmail/tokenManager";
import { fetchSendAsAliases } from "@/services/gmail/sendAs";
import { validateClientId, validateClientSecret } from "@/services/gmail/clientCredentials";
import { triggerSync, forceFullSync, resyncAccount } from "@/services/gmail/syncManager";
import { backgroundWorkerOwnsSync, reconfigureBackgroundWorkerRelay, requestWorkerResync, wakeBackgroundWorkerAndWait } from "@/services/worker/workerClient";
import {
  getGmailPushRelayStatus,
  probeGmailPushRelay,
  startGmailPushRelay,
  subscribeGmailPushRelayStatus,
  type GmailPushRelayStatus,
} from "@/services/gmail/gmailPushRelay";
import {
  registerComposeShortcut,
  getCurrentShortcut,
  DEFAULT_SHORTCUT,
} from "@/services/globalShortcut";
import {
  X,
  Plus,
  RefreshCw,
  Settings,
  PenLine,
  Bell,
  Filter,
  Users,
  UserCircle,
  Keyboard,
  Sparkles,
  Check,
  Mail,
  Info,
  ExternalLink,
  Github,
  GitFork,
  Scale,
  ChevronUp,
  ChevronDown,
  RotateCcw,
  type LucideIcon,
} from "lucide-react";
import { SignatureEditor } from "./SignatureEditor";
import { TemplateEditor } from "./TemplateEditor";
import { FilterEditor } from "./FilterEditor";
import { LabelEditor } from "./LabelEditor";
import { ContactEditor } from "./ContactEditor";
import { SubscriptionManager } from "./SubscriptionManager";
import { SemanticSearchSettings } from "./SemanticSearchSettings";
import { SmartFolderEditor } from "./SmartFolderEditor";
import { QuickStepEditor } from "./QuickStepEditor";
import { SmartLabelEditor } from "./SmartLabelEditor";
import { SHORTCUTS, getDefaultKeyMap } from "@/constants/shortcuts";
import { useShortcutStore } from "@/stores/shortcutStore";
import { useShortcutRecorder } from "@/hooks/useShortcutRecorder";
import { COLOR_THEMES } from "@/constants/themes";
import {
  getAliasesForAccount,
  setDefaultAlias,
  mapDbAlias,
  type SendAsAlias,
} from "@/services/db/sendAsAliases";
import { ALL_NAV_ITEMS } from "@/components/layout/Sidebar";
import type { SidebarNavItem } from "@/stores/uiStore";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";
import appIcon from "@/assets/icon.png";
import { AddAccount } from "@/components/accounts/AddAccount";
import { refreshAfterAccountAdded } from "@/services/accounts/accountLifecycle";

const tabs: { id: SettingsTab; label: string; icon: LucideIcon }[] = [
  { id: "general", label: "General", icon: Settings },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "composing", label: "Composing", icon: PenLine },
  { id: "mail-rules", label: "Mail Rules", icon: Filter },
  { id: "people", label: "People", icon: Users },
  { id: "accounts", label: "Accounts", icon: UserCircle },
  { id: "shortcuts", label: "Shortcuts", icon: Keyboard },
  { id: "ai", label: "AI", icon: Sparkles },
  { id: "about", label: "About", icon: Info },
];

export function SettingsPage() {
  const theme = useUIStore((s) => s.theme);
  const setTheme = useUIStore((s) => s.setTheme);
  const readingPanePosition = useUIStore((s) => s.readingPanePosition);
  const setReadingPanePosition = useUIStore((s) => s.setReadingPanePosition);
  const [imapIdle, setImapIdle] = useState(true);
  const idleStatuses = useIdleStatusStore((s) => s.statuses);
  const idleReasons = useIdleStatusStore((s) => s.reasons);
  const [reconnecting, setReconnecting] = useState<Record<string, boolean>>({});
  const [otpDetection, setOtpDetection] = useState(true);
  const [notifyAccounts, setNotifyAccounts] = useState<Set<string>>(() => new Set());
  const emailDensity = useUIStore((s) => s.emailDensity);
  const setEmailDensity = useUIStore((s) => s.setEmailDensity);
  const threadViewMode = useUIStore((s) => s.threadViewMode);
  const setThreadViewMode = useUIStore((s) => s.setThreadViewMode);
  const fontScale = useUIStore((s) => s.fontScale);
  const setFontScale = useUIStore((s) => s.setFontScale);
  const colorTheme = useUIStore((s) => s.colorTheme);
  const setColorTheme = useUIStore((s) => s.setColorTheme);
  const defaultReplyMode = useUIStore((s) => s.defaultReplyMode);
  const setDefaultReplyMode = useUIStore((s) => s.setDefaultReplyMode);
  const markAsReadBehavior = useUIStore((s) => s.markAsReadBehavior);
  const setMarkAsReadBehavior = useUIStore((s) => s.setMarkAsReadBehavior);
  const sendAndArchive = useUIStore((s) => s.sendAndArchive);
  const setSendAndArchive = useUIStore((s) => s.setSendAndArchive);
  const inboxViewMode = useUIStore((s) => s.inboxViewMode);
  const setInboxViewMode = useUIStore((s) => s.setInboxViewMode);
  const reduceMotion = useUIStore((s) => s.reduceMotion);
  const timeFormat = useUIStore((s) => s.timeFormat);
  const setTimeFormat = useUIStore((s) => s.setTimeFormat);
  const setReduceMotion = useUIStore((s) => s.setReduceMotion);
  const accounts = useAccountStore((s) => s.accounts);
  const removeAccountFromStore = useAccountStore((s) => s.removeAccount);
  const activeTab = useUIStore((s) => s.settingsTab);
  const setActiveTab = useUIStore((s) => s.setSettingsTab);
  const closeSettings = useUIStore((s) => s.closeSettings);
  const keyMap = useShortcutStore((s) => s.keyMap);
  const addAccountPending = useUIStore((s) => s.settingsAddAccountPending);
  const clearAddAccountRequest = useUIStore((s) => s.clearAddAccountRequest);
  const [showAddAccount, setShowAddAccount] = useState(false);

  // Something outside settings (command palette, sidebar) asked to add an account
  useEffect(() => {
    if (!addAccountPending) return;
    setShowAddAccount(true);
    clearAddAccountRequest();
  }, [addAccountPending, clearAddAccountRequest]);
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const [notificationBackend, setNotificationBackend] = useState<NotificationBackend>("off");
  const [undoSendDelay, setUndoSendDelay] = useState("5");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [apiSettingsSaved, setApiSettingsSaved] = useState(false);
  const clientIdError = clientId.trim() ? validateClientId(clientId) : null;
  const clientSecretError = clientSecret.trim() ? validateClientSecret(clientSecret) : null;
  const [syncOperation, setSyncOperation] = useState<"sync" | "resync" | null>(null);
  const isSyncing = syncOperation !== null;
  const [syncPeriodDays, setSyncPeriodDays] = useState("365");
  const [blockRemoteImages, setBlockRemoteImages] = useState(true);
  const [phishingDetectionEnabled, setPhishingDetectionEnabled] = useState(true);
  const [phishingSensitivity, setPhishingSensitivity] = useState<"low" | "default" | "high">("default");
  const [autostartEnabled, setAutostartEnabled] = useState(false);
  const [backgroundWorkerEnabled, setBackgroundWorkerEnabled] = useState(true);
  const [backgroundWorkerReady, setBackgroundWorkerReady] = useState(false);
  const [workerNotificationPermission, setWorkerNotificationPermission] = useState<string | null>(null);
  const [relayAccountId, setRelayAccountId] = useState("");
  const [relayReadContent, setRelayReadContent] = useState(false);
  const [relayToken, setRelayToken] = useState("");
  const [aiProvider, setAiProvider] = useState<"claude" | "openai" | "gemini" | "ollama" | "copilot">("claude");
  const [claudeApiKey, setClaudeApiKey] = useState("");
  const [openaiApiKey, setOpenaiApiKey] = useState("");
  const [geminiApiKey, setGeminiApiKey] = useState("");
  const [copilotApiKey, setCopilotApiKey] = useState("");
  const [ollamaServerUrl, setOllamaServerUrl] = useState("http://localhost:11434");
  const [ollamaModel, setOllamaModel] = useState("llama3.2");
  const [claudeModel, setClaudeModel] = useState("claude-haiku-4-5-20251001");
  const [openaiModel, setOpenaiModel] = useState("gpt-4o-mini");
  const [geminiModel, setGeminiModel] = useState("gemini-3.8-flash");
  const [copilotModel, setCopilotModel] = useState("openai/gpt-4o-mini");
  const [aiEnabled, setAiEnabled] = useState(true);
  const [aiAutoCategorize, setAiAutoCategorize] = useState(true);
  const [aiAutoSummarize, setAiAutoSummarize] = useState(true);
  const [aiKeySaved, setAiKeySaved] = useState(false);
  const [aiTesting, setAiTesting] = useState(false);
  const [aiTestResult, setAiTestResult] = useState<"success" | "fail" | null>(null);
  const [aiAutoDraftEnabled, setAiAutoDraftEnabled] = useState(true);
  const [aiWritingStyleEnabled, setAiWritingStyleEnabled] = useState(true);
  const [styleAnalyzing, setStyleAnalyzing] = useState(false);
  const [styleAnalyzeDone, setStyleAnalyzeDone] = useState(false);
  const [cacheMaxMb, setCacheMaxMb] = useState("500");
  const [cacheSizeMb, setCacheSizeMb] = useState<number | null>(null);
  const [clearingCache, setClearingCache] = useState(false);
  const [reauthStatus, setReauthStatus] = useState<Record<string, "idle" | "authorizing" | "done" | "error">>({});
  const [resyncStatus, setResyncStatus] = useState<Record<string, "idle" | "syncing" | "done" | "error">>({});
  const [autoArchiveCategories, setAutoArchiveCategories] = useState<Set<string>>(() => new Set());
  const [smartNotifications, setSmartNotifications] = useState(true);
  const [notifyCategories, setNotifyCategories] = useState<Set<string>>(() => new Set(["Primary"]));
  const [vipSenders, setVipSenders] = useState<{ email_address: string; display_name: string | null }[]>([]);
  const [newVipEmail, setNewVipEmail] = useState("");
  const [requestReadReceipts, setRequestReadReceipts] = useState(false);
  const [readReceiptResponse, setReadReceiptResponse] = useState<"ask" | "always" | "never">("ask");
  // null = system Downloads folder
  const [downloadDirSetting, setDownloadDirSetting] = useState<string | null>(null);
  const [gmailPushRelayUrl, setGmailPushRelayUrl] = useState("");
  const [gmailPushRelaySecret, setGmailPushRelaySecret] = useState("");
  const [gmailPushTopicName, setGmailPushTopicName] = useState("");
  const [gmailPushRelaySaved, setGmailPushRelaySaved] = useState(false);
  const [gmailPushRelayStatus, setGmailPushRelayStatus] = useState<GmailPushRelayStatus>(getGmailPushRelayStatus);
  const [gmailPushRelayProbing, setGmailPushRelayProbing] = useState(false);
  const [gmailPushRelayProbeError, setGmailPushRelayProbeError] = useState<string | null>(null);

  useEffect(() => subscribeGmailPushRelayStatus(setGmailPushRelayStatus), []);

  // Load settings from DB
  useEffect(() => {
    async function load() {
      const notif = await getSetting("notifications_enabled");
      setNotificationsEnabled(notif !== "false");
      setNotificationBackend(getNotificationBackend());
      const delay = await getSetting("undo_send_delay_seconds");
      setUndoSendDelay(delay ?? "5");
      const id = await getSetting("google_client_id");
      setClientId(id ?? "");
      const secret = await getSecureSetting("google_client_secret");
      setClientSecret(secret ?? "");
      setGmailPushRelayUrl((await getSetting("gmail_push_relay_url")) ?? "");
      setGmailPushRelaySecret((await getSecureSetting("gmail_push_relay_secret")) ?? "");
      setGmailPushTopicName((await getSetting("gmail_push_topic_name")) ?? "");
      const blockImg = await getSetting("block_remote_images");
      setBlockRemoteImages(blockImg !== "false");
      const phishingEnabled = await getSetting("phishing_detection_enabled");
      setPhishingDetectionEnabled(phishingEnabled !== "false");
      const phishingSens = await getSetting("phishing_sensitivity");
      if (phishingSens === "low" || phishingSens === "high") setPhishingSensitivity(phishingSens);
      const syncDays = await getSetting("sync_period_days");
      setSyncPeriodDays(syncDays ?? "365");
      setImapIdle((await getSetting("imap_idle")) !== "false");
      setOtpDetection((await getSetting("otp_detection")) !== "false");
      const accountsSetting = await getSetting("notify_accounts");
      setNotifyAccounts(new Set(accountsSetting ? accountsSetting.split(",").filter(Boolean) : []));

      const receiptDefault = await getSetting("read_receipt_request_default");
      setRequestReadReceipts(receiptDefault === "true");
      const receiptResponse = await getSetting("read_receipt_response");
      if (receiptResponse === "always" || receiptResponse === "never") {
        setReadReceiptResponse(receiptResponse);
      }
      setDownloadDirSetting(await getSetting("download_dir"));

      // Load autostart state
      try {
        const { isEnabled } = await import("@tauri-apps/plugin-autostart");
        setAutostartEnabled(await isEnabled());
      } catch {
        // autostart plugin may not be available in dev
      }
      setBackgroundWorkerEnabled((await getSetting("background_worker_enabled")) !== "false");
      setBackgroundWorkerReady(await invoke<boolean>("worker_is_ready").catch(() => false));
      try {
        const db = await getDb();
        const [status] = await db.select<{ phase: string; permission: string; error: string | null }[]>(
          "SELECT phase, permission, error FROM worker_notification_status WHERE id = 1",
        );
        setWorkerNotificationPermission(status
          ? status.permission === "denied"
            ? "denied"
            : status.error ?? status.permission
          : null);
      } catch {
        setWorkerNotificationPermission(null);
      }

      // Load AI settings
      const provider = await getSetting("ai_provider");
      if (provider === "openai" || provider === "gemini" || provider === "ollama" || provider === "copilot") setAiProvider(provider);
      const ollamaUrl = await getSetting("ollama_server_url");
      if (ollamaUrl) setOllamaServerUrl(ollamaUrl);
      const ollamaModelVal = await getSetting("ollama_model");
      if (ollamaModelVal) setOllamaModel(ollamaModelVal);
      const claudeModelVal = await getSetting("claude_model");
      if (claudeModelVal) setClaudeModel(claudeModelVal);
      const openaiModelVal = await getSetting("openai_model");
      if (openaiModelVal) setOpenaiModel(openaiModelVal);
      const geminiModelVal = await getSetting("gemini_model");
      if (geminiModelVal) setGeminiModel(resolveModelId(geminiModelVal));
      const aiKey = await getSecureSetting("claude_api_key");
      setClaudeApiKey(aiKey ?? "");
      const oaiKey = await getSecureSetting("openai_api_key");
      setOpenaiApiKey(oaiKey ?? "");
      const gemKey = await getSecureSetting("gemini_api_key");
      setGeminiApiKey(gemKey ?? "");
      const copKey = await getSecureSetting("copilot_api_key");
      setCopilotApiKey(copKey ?? "");
      const copilotModelVal = await getSetting("copilot_model");
      if (copilotModelVal) setCopilotModel(copilotModelVal);
      const aiEn = await getSetting("ai_enabled");
      setAiEnabled(aiEn !== "false");
      const aiCat = await getSetting("ai_auto_categorize");
      setAiAutoCategorize(aiCat !== "false");
      const aiSum = await getSetting("ai_auto_summarize");
      setAiAutoSummarize(aiSum !== "false");
      const aiDraft = await getSetting("ai_auto_draft_enabled");
      setAiAutoDraftEnabled(aiDraft !== "false");
      const aiStyle = await getSetting("ai_writing_style_enabled");
      setAiWritingStyleEnabled(aiStyle !== "false");

      // Load auto-archive categories
      const autoArchive = await getSetting("auto_archive_categories");
      if (autoArchive) {
        setAutoArchiveCategories(new Set(autoArchive.split(",").map((s) => s.trim()).filter(Boolean)));
      }

      // Load smart notification settings
      const smartNotif = await getSetting("smart_notifications");
      setSmartNotifications(smartNotif !== "false");
      const notifCats = await getSetting("notify_categories");
      if (notifCats) {
        setNotifyCategories(new Set(notifCats.split(",").map((s) => s.trim()).filter(Boolean)));
      }
      try {
        const { getAllVipSenders } = await import("@/services/db/notificationVips");
        const activeId = accounts.find((a) => a.isActive)?.id;
        if (activeId) {
          const vips = await getAllVipSenders(activeId);
          setVipSenders(vips.map((v) => ({ email_address: v.email_address, display_name: v.display_name })));
        }
      } catch {
        // VIP table may not exist yet
      }

      // Load cache settings
      const cacheMax = await getSetting("attachment_cache_max_mb");
      setCacheMaxMb(cacheMax ?? "500");
      try {
        const { getCacheSize } = await import("@/services/attachments/cacheManager");
        const size = await getCacheSize();
        setCacheSizeMb(Math.round(size / (1024 * 1024) * 10) / 10);
      } catch {
        // cache manager may not be available
      }
    }
    load();
  }, []);

  const handleNotificationsToggle = useCallback(async () => {
    const newVal = !notificationsEnabled;
    setNotificationsEnabled(newVal);
    await setSetting("notifications_enabled", newVal ? "true" : "false");
    // Takes effect now, not at the next start; switching on may show the
    // system permission prompt
    await applyNotificationsEnabled(newVal);
    setNotificationBackend(getNotificationBackend());
  }, [notificationsEnabled]);

  const handleUndoDelayChange = useCallback(async (value: string) => {
    setUndoSendDelay(value);
    await setSetting("undo_send_delay_seconds", value);
  }, []);

  const handleRequestReadReceiptsToggle = useCallback(async () => {
    const newVal = !requestReadReceipts;
    setRequestReadReceipts(newVal);
    await setSetting("read_receipt_request_default", newVal ? "true" : "false");
  }, [requestReadReceipts]);

  const handleReadReceiptResponseChange = useCallback(async (value: "ask" | "always" | "never") => {
    setReadReceiptResponse(value);
    await setSetting("read_receipt_response", value);
  }, []);

  const handleSaveApiSettings = useCallback(async () => {
    const trimmedId = clientId.trim();
    const trimmedSecret = clientSecret.trim();
    // Never persist swapped credentials — Google only reports that as
    // `invalid_client` on its own page, after the browser is already open.
    if (trimmedId && validateClientId(trimmedId)) return;
    if (trimmedSecret && validateClientSecret(trimmedSecret)) return;
    if (trimmedId) {
      await setSetting("google_client_id", trimmedId);
    }
    if (trimmedSecret) {
      await setSecureSetting("google_client_secret", trimmedSecret);
    }
    setApiSettingsSaved(true);
    setTimeout(() => setApiSettingsSaved(false), 2000);
  }, [clientId, clientSecret]);

  const handleSaveGmailPushRelay = useCallback(async () => {
    const url = gmailPushRelayUrl.trim().replace(/\/+$/, "");
    if (url) await setSetting("gmail_push_relay_url", url);
    else await setSetting("gmail_push_relay_url", "");
    if (gmailPushRelaySecret.trim()) await setSecureSetting("gmail_push_relay_secret", gmailPushRelaySecret.trim());
    await setSetting("gmail_push_topic_name", gmailPushTopicName.trim());
    if (backgroundWorkerOwnsSync()) await reconfigureBackgroundWorkerRelay();
    else void startGmailPushRelay();
    setGmailPushRelaySaved(true);
    setTimeout(() => setGmailPushRelaySaved(false), 2000);
  }, [gmailPushRelaySecret, gmailPushRelayUrl, gmailPushTopicName]);

  const handleProbeGmailPushRelay = useCallback(async () => {
    setGmailPushRelayProbing(true);
    setGmailPushRelayProbeError(null);
    try {
      await probeGmailPushRelay();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setGmailPushRelayProbeError(message);
    } finally {
      setGmailPushRelayProbing(false);
    }
  }, []);

  const handleManualSync = useCallback(async () => {
    const activeIds = accounts.filter((a) => a.isActive).map((a) => a.id);
    if (activeIds.length === 0) return;
    setSyncOperation("sync");
    try {
      if (backgroundWorkerOwnsSync()) await wakeBackgroundWorkerAndWait(activeIds);
      else await triggerSync(activeIds);
    } catch (error) {
      reportError("Could not sync mail", error);
    } finally {
      setSyncOperation(null);
    }
  }, [accounts]);

  const handleForceFullSync = useCallback(async () => {
    const activeIds = accounts.filter((a) => a.isActive).map((a) => a.id);
    if (activeIds.length === 0) return;
    setSyncOperation("resync");
    try {
      if (backgroundWorkerOwnsSync()) await requestWorkerResync(activeIds);
      else await forceFullSync(activeIds);
    } catch (error) {
      reportError("Full resync failed", error);
    } finally {
      setSyncOperation(null);
    }
  }, [accounts]);

  const handleAutostartToggle = useCallback(async () => {
    try {
      const { enable, disable } = await import("@tauri-apps/plugin-autostart");
      if (autostartEnabled) {
        await disable();
      } else {
        await enable();
      }
      setAutostartEnabled(!autostartEnabled);
    } catch (err) {
      console.error("Failed to toggle autostart:", err);
    }
  }, [autostartEnabled]);

  const handleBackgroundWorkerToggle = useCallback(async () => {
    try {
      if (useComposerStore.getState().isOpen) {
        throw new Error("Close the composer after its draft has saved, then change background mail.");
      }
      if (backgroundWorkerEnabled) {
        await invoke("worker_disable");
        for (let attempt = 0; attempt < 20; attempt++) {
          if (!(await invoke<boolean>("worker_is_running"))) break;
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        if (await invoke<boolean>("worker_is_running")) {
          throw new Error("The helper is still shutting down. Try again in a moment.");
        }
        await setSetting("background_worker_enabled", "false");
      } else {
        // Reload first so the frontend releases its own watchers before the
        // helper is registered by App startup.
        await setSetting("background_worker_enabled", "true");
      }
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (error) {
      reportError("Could not change background mail", error);
    }
  }, [backgroundWorkerEnabled]);

  const handleRelayGrant = useCallback(async () => {
    if (!relayAccountId) return;
    try {
      const token = await invoke<string>("worker_create_relay_profile", {
        profileId: "commonplace",
        accountIds: [relayAccountId],
        readContent: relayReadContent,
      });
      setRelayToken(token);
    } catch (error) {
      reportError("Could not grant Commonplace mail access", error);
    }
  }, [relayAccountId, relayReadContent]);

  const handleRelayRevoke = useCallback(async () => {
    try {
      await invoke("worker_revoke_relay_profile", { profileId: "commonplace" });
      setRelayToken("");
      notify("success", "Commonplace mail access revoked");
    } catch (error) {
      reportError("Could not revoke Commonplace mail access", error);
    }
  }, []);

  const handleRemoveAccount = useCallback(
    async (accountId: string) => {
      removeClient(accountId);
      await deleteAccount(accountId);
      removeAccountFromStore(accountId);
      if (backgroundWorkerOwnsSync()) {
        void reconfigureBackgroundWorkerRelay().catch((error) =>
          console.warn("Could not refresh background worker account configuration:", error),
        );
      }
    },
    [removeAccountFromStore],
  );

  const handleReauthorizeAccount = useCallback(
    async (accountId: string, email: string) => {
      setReauthStatus((prev) => ({ ...prev, [accountId]: "authorizing" }));
      try {
        await reauthorizeAccount(accountId, email);
        setReauthStatus((prev) => ({ ...prev, [accountId]: "done" }));
        notify("success", `${email} re-authorised`, "Starting instant delivery with the new permissions.");
        // The new token carries the IMAP scope — use it now rather than
        // waiting for the next launch or a manual Reconnect
        try {
          const { reconnectAccount } = await import("@/services/imap/idleManager");
          await reconnectAccount(accountId);
        } catch (err) {
          reportError(`Could not start instant delivery for ${email}`, err);
        }
        setTimeout(() => {
          setReauthStatus((prev) => ({ ...prev, [accountId]: "idle" }));
        }, 3000);
      } catch (err) {
        // The browser can crash mid sign-in, the tab can be closed, the
        // wrong account can be picked — say which, and offer the retry
        reportError(`Re-authorisation failed for ${email}`, err, {
          label: "Try again",
          run: () => handleReauthorizeAccount(accountId, email),
        });
        setReauthStatus((prev) => ({ ...prev, [accountId]: "error" }));
        setTimeout(() => {
          setReauthStatus((prev) => ({ ...prev, [accountId]: "idle" }));
        }, 3000);
      }
    },
    [],
  );

  const handleResyncAccount = useCallback(
    async (accountId: string) => {
      setResyncStatus((prev) => ({ ...prev, [accountId]: "syncing" }));
      try {
        if (backgroundWorkerOwnsSync()) await requestWorkerResync([accountId]);
        else await resyncAccount(accountId);
        setResyncStatus((prev) => ({ ...prev, [accountId]: "done" }));
        setTimeout(() => {
          setResyncStatus((prev) => ({ ...prev, [accountId]: "idle" }));
        }, 3000);
      } catch (err) {
        reportError("Resync failed", err);
        setResyncStatus((prev) => ({ ...prev, [accountId]: "error" }));
        setTimeout(() => {
          setResyncStatus((prev) => ({ ...prev, [accountId]: "idle" }));
        }, 3000);
      }
    },
    [],
  );

  const activeTabDef = tabs.find((t) => t.id === activeTab);

  return (
    <div className="flex flex-col h-full min-w-0 overflow-hidden bg-bg-primary/50">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-3 border-b border-border-primary shrink-0 bg-bg-primary/60 backdrop-blur-sm">
        <h1 className="text-base font-semibold text-text-primary">Settings</h1>
        <kbd className="text-[0.625rem] text-text-tertiary bg-bg-tertiary px-1.5 py-0.5 rounded font-mono">
          {keyMap["app.settings"] ?? "Ctrl+,"}
        </kbd>
        <Tooltip content="Close settings (Esc)"><button
          onClick={closeSettings}
          className="ml-auto p-1.5 -mr-1 rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"

          aria-label="Close settings"
        >
          <X size={18} />
        </button></Tooltip>
      </div>

      {/* Body: sidebar nav + content */}
      <div className="flex flex-1 min-h-0">
        {/* Vertical tab sidebar */}
        <nav className="w-44 border-r border-border-primary py-2 overflow-y-auto shrink-0 bg-bg-primary/30">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2.5 w-full px-4 py-2 text-[0.8125rem] transition-colors ${
                  isActive
                    ? "bg-bg-selected text-accent font-medium"
                    : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                }`}
              >
                <Icon size={15} className="shrink-0" />
                {tab.label}
              </button>
            );
          })}
        </nav>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-2xl px-7 py-6">
            {/* Tab title */}
            {activeTabDef && (
              <div className="mb-6">
                <h2 className="text-lg font-semibold text-text-primary">
                  {activeTabDef.label}
                </h2>
              </div>
            )}

            <div className="space-y-8">
        {activeTab === "general" && <SemanticSearchSettings />}
        {activeTab === "general" && (
                <>
                  <Section title="Appearance">
                    <SettingRow label="Theme">
                      <select
                        value={theme}
                        onChange={(e) => {
                          const val = e.target.value as "light" | "dark" | "system";
                          setTheme(val);
                          setSetting("theme", val);
                        }}
                        className="w-48 bg-bg-tertiary text-text-primary text-sm px-3 py-1.5 rounded-md border border-border-primary focus:border-accent outline-none"
                      >
                        <option value="system">System</option>
                        <option value="light">Light</option>
                        <option value="dark">Dark</option>
                      </select>
                    </SettingRow>
                    <SettingRow label="Reading pane">
                      <select
                        value={readingPanePosition}
                        onChange={(e) => {
                          setReadingPanePosition(e.target.value as "right" | "bottom" | "hidden");
                        }}
                        className="w-48 bg-bg-tertiary text-text-primary text-sm px-3 py-1.5 rounded-md border border-border-primary focus:border-accent outline-none"
                      >
                        <option value="right">Right</option>
                        <option value="bottom">Bottom</option>
                        <option value="hidden">Off</option>
                      </select>
                    </SettingRow>
                    <SettingRow label="Email density">
                      <select
                        value={emailDensity}
                        onChange={(e) => {
                          setEmailDensity(e.target.value as "compact" | "default" | "spacious");
                        }}
                        className="w-48 bg-bg-tertiary text-text-primary text-sm px-3 py-1.5 rounded-md border border-border-primary focus:border-accent outline-none"
                      >
                        <option value="compact">Compact</option>
                        <option value="default">Default</option>
                        <option value="spacious">Spacious</option>
                      </select>
                    </SettingRow>
                    <SettingRow label="Thread layout">
                      <select
                        value={threadViewMode}
                        onChange={(e) => {
                          setThreadViewMode(e.target.value as "classic" | "chat");
                        }}
                        className="w-48 bg-bg-tertiary text-text-primary text-sm px-3 py-1.5 rounded-md border border-border-primary focus:border-accent outline-none"
                      >
                        <option value="classic">Message list</option>
                        <option value="chat">Chat bubbles</option>
                      </select>
                    </SettingRow>
                    <SettingRow label="Font size">
                      <select
                        value={fontScale}
                        onChange={(e) => {
                          setFontScale(e.target.value as "small" | "default" | "large" | "xlarge");
                        }}
                        className="w-48 bg-bg-tertiary text-text-primary text-sm px-3 py-1.5 rounded-md border border-border-primary focus:border-accent outline-none"
                      >
                        <option value="small">Small</option>
                        <option value="default">Default</option>
                        <option value="large">Large</option>
                        <option value="xlarge">Extra Large</option>
                      </select>
                    </SettingRow>
                    <SettingRow label="Accent color">
                      <div className="flex items-center gap-2">
                        {COLOR_THEMES.map((t) => {
                          const isSelected = colorTheme === t.id;
                          return (
                            <Tooltip content={t.name}><button
                              key={t.id}
                              onClick={() => setColorTheme(t.id)}

                              className={`relative w-7 h-7 rounded-full transition-all ${
                                isSelected
                                  ? "ring-2 ring-offset-2 ring-offset-bg-primary scale-110"
                                  : "hover:scale-105"
                              }`}
                              style={{
                                backgroundColor: t.swatch,
                                boxShadow: isSelected
                                  ? `0 0 0 2px var(--color-bg-primary), 0 0 0 4px ${t.swatch}`
                                  : undefined,
                              }}
                            >
                              {isSelected && (
                                <Check size={14} className="absolute inset-0 m-auto text-white drop-shadow-sm" />
                              )}
                            </button></Tooltip>
                          );
                        })}
                      </div>
                    </SettingRow>
                    <SettingRow label="Inbox view mode">
                      <select
                        value={inboxViewMode}
                        onChange={(e) => {
                          setInboxViewMode(e.target.value as "unified" | "split");
                        }}
                        className="w-48 bg-bg-tertiary text-text-primary text-sm px-3 py-1.5 rounded-md border border-border-primary focus:border-accent outline-none"
                      >
                        <option value="unified">Unified</option>
                        <option value="split">Split (Categories)</option>
                      </select>
                    </SettingRow>
                    <SettingRow label="Time format">
                      <select
                        value={timeFormat}
                        onChange={(e) =>
                          setTimeFormat(e.target.value as "system" | "12h" | "24h")
                        }
                        className="w-48 bg-bg-tertiary text-text-primary text-sm px-3 py-1.5 rounded-md border border-border-primary focus:border-accent outline-none"
                      >
                        <option value="system">Match system</option>
                        <option value="12h">12-hour (1:30 PM)</option>
                        <option value="24h">24-hour (13:30)</option>
                      </select>
                    </SettingRow>
                    <ToggleRow
                      label="Reduce motion"
                      description="Disable UI animations and transitions"
                      checked={reduceMotion}
                      onToggle={() => setReduceMotion(!reduceMotion)}
                    />
                  </Section>

                  <SidebarNavEditor />

                  <Section title="Startup">
                    <ToggleRow
                      label="Background mail helper"
                      description="Check mail and login codes at sign-in, even while the sndmail window is closed"
                      checked={backgroundWorkerEnabled}
                      onToggle={handleBackgroundWorkerToggle}
                    />
                    <p className="text-xs text-text-tertiary px-1">
                      {backgroundWorkerEnabled
                        ? backgroundWorkerReady ? "Helper connected" : "Helper starting or needs attention"
                        : "Background mail is off"}
                    </p>
                    {backgroundWorkerEnabled && workerNotificationPermission === "denied" && (
                      <p className="text-xs text-warning px-1">
                        Background notifications are blocked. Open System Settings → Notifications → SndmailWorker and enable Allow Notifications.
                      </p>
                    )}
                    {backgroundWorkerEnabled && workerNotificationPermission && workerNotificationPermission !== "denied" && (
                      <p className="text-xs text-text-tertiary px-1">
                        Background notification status: {workerNotificationPermission.replaceAll("_", " ")}.
                      </p>
                    )}
                    <ToggleRow
                      label="Launch at login"
                      description="Also open the full sndmail app at login, minimized to the tray"
                      checked={autostartEnabled}
                      onToggle={handleAutostartToggle}
                    />
                  </Section>

                  <Section title="Commonplace mail relay">
                    <p className="text-sm text-text-secondary">
                      Grant Commonplace local read access to one mailbox. The token is shown once; creating a new one replaces the old grant.
                    </p>
                    <SettingRow label="Mailbox">
                      <select
                        value={relayAccountId}
                        onChange={(event) => setRelayAccountId(event.target.value)}
                        className="w-56 bg-bg-tertiary text-text-primary text-sm px-3 py-1.5 rounded-md border border-border-primary"
                      >
                        <option value="">Choose a mailbox</option>
                        {accounts.filter((account) => account.provider !== "caldav").map((account) => (
                          <option key={account.id} value={account.id}>{account.email}</option>
                        ))}
                      </select>
                    </SettingRow>
                    <ToggleRow
                      label="Allow message content"
                      description="Off by default. Metadata access never includes subjects, snippets, bodies, credentials, or login codes."
                      checked={relayReadContent}
                      onToggle={() => setRelayReadContent(!relayReadContent)}
                    />
                    <div className="flex gap-2">
                      <Button variant="secondary" size="md" onClick={handleRelayGrant} disabled={!relayAccountId}>Create access token</Button>
                      <Button variant="secondary" size="md" onClick={handleRelayRevoke}>Revoke access</Button>
                    </div>
                    {relayToken && (
                      <SettingRow label="Copy this token now">
                        <input
                          readOnly
                          value={relayToken}
                          onFocus={(event) => event.currentTarget.select()}
                          className="w-80 bg-bg-tertiary text-text-primary text-xs px-3 py-1.5 rounded-md border border-border-primary"
                          aria-label="Commonplace mail relay access token"
                        />
                      </SettingRow>
                    )}
                  </Section>

                  <Section title="Privacy & Security">
                    <ToggleRow
                      label="Block remote images"
                      description="Hides tracking pixels and remote images until you choose to load them"
                      checked={blockRemoteImages}
                      onToggle={async () => {
                        const newVal = !blockRemoteImages;
                        setBlockRemoteImages(newVal);
                        await setSetting("block_remote_images", newVal ? "true" : "false");
                      }}
                    />
                    <ToggleRow
                      label="Phishing link detection"
                      description="Scan message links for phishing indicators and show warnings"
                      checked={phishingDetectionEnabled}
                      onToggle={async () => {
                        const newVal = !phishingDetectionEnabled;
                        setPhishingDetectionEnabled(newVal);
                        await setSetting("phishing_detection_enabled", newVal ? "true" : "false");
                      }}
                    />
                    {phishingDetectionEnabled && (
                      <SettingRow label="Detection sensitivity">
                        <select
                          value={phishingSensitivity}
                          onChange={async (e) => {
                            const val = e.target.value as "low" | "default" | "high";
                            setPhishingSensitivity(val);
                            await setSetting("phishing_sensitivity", val);
                          }}
                          className="w-48 bg-bg-tertiary text-text-primary text-sm px-3 py-1.5 rounded-md border border-border-primary focus:border-accent outline-none"
                        >
                          <option value="low">Low (fewer warnings)</option>
                          <option value="default">Default</option>
                          <option value="high">High (more warnings)</option>
                        </select>
                      </SettingRow>
                    )}
                  </Section>

                  <Section title="Storage">
                    <div className="flex items-center justify-between">
                      <div className="min-w-0 mr-4">
                        <span className="text-sm text-text-secondary">Downloads folder</span>
                        <p className="text-xs text-text-tertiary mt-0.5 truncate">
                          {downloadDirSetting ?? "System Downloads folder"}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {downloadDirSetting && (
                          <Button
                            variant="secondary"
                            onClick={async () => {
                              setDownloadDirSetting(null);
                              await setSetting("download_dir", "");
                            }}
                            className="bg-bg-tertiary text-text-primary border border-border-primary"
                          >
                            Reset
                          </Button>
                        )}
                        <Button
                          variant="secondary"
                          onClick={async () => {
                            const { open } = await import("@tauri-apps/plugin-dialog");
                            const dir = await open({ directory: true, multiple: false, title: "Choose downloads folder" });
                            if (!dir || Array.isArray(dir)) return;
                            setDownloadDirSetting(dir);
                            await setSetting("download_dir", dir);
                          }}
                          className="bg-bg-tertiary text-text-primary border border-border-primary"
                        >
                          Choose...
                        </Button>
                      </div>
                    </div>
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="text-sm text-text-secondary">Attachment cache</span>
                        <p className="text-xs text-text-tertiary mt-0.5">
                          {cacheSizeMb !== null ? `${cacheSizeMb} MB used` : "Calculating..."}
                        </p>
                      </div>
                      <Button
                        variant="secondary"
                        onClick={async () => {
                          setClearingCache(true);
                          try {
                            const { clearAllCache } = await import("@/services/attachments/cacheManager");
                            await clearAllCache();
                            setCacheSizeMb(0);
                          } catch (err) {
                            console.error("Failed to clear cache:", err);
                          } finally {
                            setClearingCache(false);
                          }
                        }}
                        disabled={clearingCache}
                        className="bg-bg-tertiary text-text-primary border border-border-primary"
                      >
                        {clearingCache ? "Clearing..." : "Clear Cache"}
                      </Button>
                    </div>
                    <SettingRow label="Max cache size">
                      <select
                        value={cacheMaxMb}
                        onChange={async (e) => {
                          const val = e.target.value;
                          setCacheMaxMb(val);
                          await setSetting("attachment_cache_max_mb", val);
                        }}
                        className="w-48 bg-bg-tertiary text-text-primary text-sm px-3 py-1.5 rounded-md border border-border-primary focus:border-accent outline-none"
                      >
                        <option value="100">100 MB</option>
                        <option value="250">250 MB</option>
                        <option value="500">500 MB</option>
                        <option value="1000">1 GB</option>
                        <option value="2000">2 GB</option>
                      </select>
                    </SettingRow>
                  </Section>
                </>
              )}

              {activeTab === "notifications" && (
                <>
                  <Section title="Notifications">
                    <ToggleRow
                      label="Enable notifications"
                      checked={notificationsEnabled}
                      onToggle={handleNotificationsToggle}
                    />
                    <ToggleRow
                      label="Smart notifications"
                      description="Only notify for selected categories and VIP senders"
                      checked={smartNotifications}
                      onToggle={async () => {
                        const newVal = !smartNotifications;
                        setSmartNotifications(newVal);
                        await setSetting("smart_notifications", newVal ? "true" : "false");
                      }}
                    />
                    {notificationsEnabled && (
                      <NotificationButtonsRow backend={notificationBackend} />
                    )}
                  </Section>

                  <Section title="One-time codes & sign-in links">
                    <p className="text-xs text-text-tertiary mb-2">
                      These stand on their own. A code or a sign-in link is announced
                      even when every mailbox below is switched off — it is worthless
                      a minute later, which is the opposite of ordinary mail.
                    </p>
                    <ToggleRow
                      label="Detect login codes"
                      description="Spot verification codes in arriving mail and copy them to the clipboard immediately"
                      checked={otpDetection}
                      onToggle={async () => {
                        const next = !otpDetection;
                        setOtpDetection(next);
                        await setSetting("otp_detection", next ? "true" : "false");
                      }}
                    />
                  </Section>

                  <Section title="Which mailboxes">
                    <p className="text-xs text-text-tertiary mb-2">
                      Only the mailboxes you pick will notify. Pick none for silence —
                      one-time codes and sign-in links come through regardless.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {accounts.map((account) => (
                        <button
                          key={account.id}
                          onClick={async () => {
                            const next = new Set(notifyAccounts);
                            if (next.has(account.id)) next.delete(account.id);
                            else next.add(account.id);
                            setNotifyAccounts(next);
                            await setSetting("notify_accounts", [...next].join(","));
                          }}
                          className={`px-2.5 py-1 text-xs rounded-full transition-colors border ${
                            notifyAccounts.has(account.id)
                              ? "bg-accent/15 text-accent border-accent/30"
                              : "bg-bg-tertiary text-text-tertiary border-border-primary hover:text-text-primary"
                          }`}
                        >
                          {account.email}
                        </button>
                      ))}
                    </div>
                  </Section>

                  <Section title="Rules">
                    <p className="text-xs text-text-tertiary">
                      Any mail rule can carry a <strong>Notify me</strong> action, which always
                      announces a match whatever the filters above say. Build one under
                      Settings → Mail rules.
                    </p>
                  </Section>

                  {smartNotifications && (
                    <>
                      <Section title="Category Filters">
                        <div>
                          <span className="text-sm text-text-secondary">Notify for categories</span>
                          <div className="flex flex-wrap gap-2 mt-2">
                            {(["Primary", "Updates", "Promotions", "Social", "Newsletters"] as const).map((cat) => (
                              <button
                                key={cat}
                                onClick={async () => {
                                  const next = new Set(notifyCategories);
                                  if (next.has(cat)) next.delete(cat);
                                  else next.add(cat);
                                  setNotifyCategories(next);
                                  await setSetting("notify_categories", [...next].join(","));
                                }}
                                className={`px-2.5 py-1 text-xs rounded-full transition-colors border ${
                                  notifyCategories.has(cat)
                                    ? "bg-accent/15 text-accent border-accent/30"
                                    : "bg-bg-tertiary text-text-tertiary border-border-primary hover:text-text-primary"
                                }`}
                              >
                                {cat}
                              </button>
                            ))}
                          </div>
                        </div>
                      </Section>

                      <Section title="VIP Senders">
                        <p className="text-xs text-text-tertiary mb-2">
                          These senders always trigger notifications regardless of category
                        </p>
                        <div className="space-y-1.5">
                          {vipSenders.map((vip) => (
                            <div key={vip.email_address} className="flex items-center justify-between py-1.5 px-3 bg-bg-secondary rounded-md">
                              <span className="text-xs text-text-primary truncate">
                                {vip.display_name ? `${vip.display_name} (${vip.email_address})` : vip.email_address}
                              </span>
                              <button
                                onClick={async () => {
                                  const activeId = accounts.find((a) => a.isActive)?.id;
                                  if (!activeId) return;
                                  const { removeVipSender } = await import("@/services/db/notificationVips");
                                  await removeVipSender(activeId, vip.email_address);
                                  setVipSenders((prev) => prev.filter((v) => v.email_address !== vip.email_address));
                                }}
                                className="text-xs text-danger hover:text-danger/80 ml-2 shrink-0"
                              >
                                Remove
                              </button>
                            </div>
                          ))}
                        </div>
                        <div className="flex gap-2 mt-2">
                          <input
                            type="email"
                            value={newVipEmail}
                            onChange={(e) => setNewVipEmail(e.target.value)}
                            placeholder="email@example.com"
                            className="flex-1 px-3 py-1.5 bg-bg-tertiary border border-border-primary rounded-md text-xs text-text-primary outline-none focus:border-accent"
                            onKeyDown={async (e) => {
                              if (e.key !== "Enter" || !newVipEmail.trim()) return;
                              const activeId = accounts.find((a) => a.isActive)?.id;
                              if (!activeId) return;
                              const { addVipSender } = await import("@/services/db/notificationVips");
                              await addVipSender(activeId, newVipEmail.trim());
                              setVipSenders((prev) => [...prev, { email_address: newVipEmail.trim().toLowerCase(), display_name: null }]);
                              setNewVipEmail("");
                            }}
                          />
                          <Button
                            variant="primary"
                            onClick={async () => {
                              if (!newVipEmail.trim()) return;
                              const activeId = accounts.find((a) => a.isActive)?.id;
                              if (!activeId) return;
                              const { addVipSender } = await import("@/services/db/notificationVips");
                              await addVipSender(activeId, newVipEmail.trim());
                              setVipSenders((prev) => [...prev, { email_address: newVipEmail.trim().toLowerCase(), display_name: null }]);
                              setNewVipEmail("");
                            }}
                            disabled={!newVipEmail.trim()}
                          >
                            Add
                          </Button>
                        </div>
                      </Section>
                    </>
                  )}
                </>
              )}

              {activeTab === "composing" && (
                <>
                  <Section title="Sending">
                    <SettingRow label="Undo send delay">
                      <select
                        value={undoSendDelay}
                        onChange={(e) => handleUndoDelayChange(e.target.value)}
                        className="w-48 bg-bg-tertiary text-text-primary text-sm px-3 py-1.5 rounded-md border border-border-primary focus:border-accent outline-none"
                      >
                        <option value="5">5 seconds</option>
                        <option value="10">10 seconds</option>
                        <option value="30">30 seconds</option>
                      </select>
                    </SettingRow>
                    <ToggleRow
                      label="Send and archive"
                      description="Automatically archive threads after sending a reply"
                      checked={sendAndArchive}
                      onToggle={() => setSendAndArchive(!sendAndArchive)}
                    />
                  </Section>

                  <Section title="Read receipts">
                    <ToggleRow
                      label="Request read receipts"
                      description="Ask recipients to confirm when they open your emails. Their mail client decides whether to answer."
                      checked={requestReadReceipts}
                      onToggle={handleRequestReadReceiptsToggle}
                    />
                    <SettingRow label="When a receipt is requested">
                      <select
                        value={readReceiptResponse}
                        onChange={(e) => {
                          handleReadReceiptResponseChange(e.target.value as "ask" | "always" | "never");
                        }}
                        className="w-48 bg-bg-tertiary text-text-primary text-sm px-3 py-1.5 rounded-md border border-border-primary focus:border-accent outline-none"
                      >
                        <option value="ask">Ask me</option>
                        <option value="always">Always send</option>
                        <option value="never">Never send</option>
                      </select>
                    </SettingRow>
                  </Section>

                  <Section title="Behavior">
                    <SettingRow label="Default reply action">
                      <select
                        value={defaultReplyMode}
                        onChange={(e) => {
                          setDefaultReplyMode(e.target.value as "reply" | "replyAll");
                        }}
                        className="w-48 bg-bg-tertiary text-text-primary text-sm px-3 py-1.5 rounded-md border border-border-primary focus:border-accent outline-none"
                      >
                        <option value="reply">Reply</option>
                        <option value="replyAll">Reply All</option>
                      </select>
                    </SettingRow>
                    <SettingRow label="Mark as read">
                      <select
                        value={markAsReadBehavior}
                        onChange={(e) => {
                          setMarkAsReadBehavior(e.target.value as "instant" | "2s" | "manual");
                        }}
                        className="w-48 bg-bg-tertiary text-text-primary text-sm px-3 py-1.5 rounded-md border border-border-primary focus:border-accent outline-none"
                      >
                        <option value="instant">Instantly</option>
                        <option value="2s">After 2 seconds</option>
                        <option value="manual">Manually</option>
                      </select>
                    </SettingRow>
                  </Section>

                  <Section title="Signatures">
                    <SignatureEditor />
                  </Section>

                  <Section title="Templates">
                    <TemplateEditor />
                  </Section>
                </>
              )}

              {activeTab === "mail-rules" && (
                <>
                  <Section title="Labels">
                    <p className="text-xs text-text-tertiary mb-3">
                      Create, rename, recolor, delete, or reorder your Gmail labels.
                    </p>
                    <LabelEditor />
                  </Section>

                  <Section title="Filters">
                    <p className="text-xs text-text-tertiary mb-3">
                      Filters automatically apply actions to new incoming emails during sync.
                    </p>
                    <FilterEditor />
                  </Section>

                  <Section title="Smart Labels">
                    <p className="text-xs text-text-tertiary mb-3">
                      Describe what emails should get a label using plain English. AI automatically labels matching emails during sync.
                    </p>
                    <SmartLabelEditor />
                  </Section>

                  <Section title="Smart Folders">
                    <p className="text-xs text-text-tertiary mb-3">
                      Smart folders are saved searches that automatically show matching emails. Use search operators like <code className="bg-bg-tertiary px-1 rounded">is:unread</code>, <code className="bg-bg-tertiary px-1 rounded">from:</code>, <code className="bg-bg-tertiary px-1 rounded">has:attachment</code>, <code className="bg-bg-tertiary px-1 rounded">after:</code>.
                    </p>
                    <SmartFolderEditor />
                  </Section>

                  <Section title="Quick Steps">
                    <p className="text-xs text-text-tertiary mb-3">
                      Quick steps let you chain multiple actions together into a single click.
                      Apply them from the right-click menu on any thread.
                    </p>
                    <QuickStepEditor />
                  </Section>
                </>
              )}

              {activeTab === "people" && (
                <>
                  <Section title="Contacts">
                    <p className="text-xs text-text-tertiary mb-3">
                      Contacts are automatically added when you send or receive emails. Edit display names or remove contacts below.
                    </p>
                    <ContactEditor />
                  </Section>

                  <Section title="Subscriptions">
                    <p className="text-xs text-text-tertiary mb-3">
                      View all detected newsletter and promotional senders. Unsubscribe using RFC 8058 one-click POST, mailto, or browser fallback.
                    </p>
                    <SubscriptionManager />
                  </Section>
                </>
              )}

              {activeTab === "accounts" && (
                <>
                  <Section
                    title="Mail Accounts"
                    action={
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={<Plus size={14} />}
                        onClick={() => setShowAddAccount(true)}
                      >
                        Add account
                      </Button>
                    }
                  >
                    {accounts.filter((a) => a.provider !== "caldav").length === 0 ? (
                      <button
                        onClick={() => setShowAddAccount(true)}
                        className="w-full flex flex-col items-center gap-2 px-4 py-8 rounded-lg border border-dashed border-border-primary text-center hover:border-accent hover:bg-bg-hover transition-colors"
                      >
                        <Mail className="w-6 h-6 text-text-tertiary" />
                        <span className="text-sm font-medium text-text-primary">
                          Connect your first mailbox
                        </span>
                        <span className="text-xs text-text-tertiary">
                          Sign in with Google, or set up any IMAP/SMTP provider
                        </span>
                      </button>
                    ) : (
                      <div className="space-y-2">
                        {accounts.filter((a) => a.provider !== "caldav").map((account, accountIndex) => {
                          const providerLabel = account.provider === "imap" ? "IMAP" : "Gmail";
                          const current = accountColor(account.color, accountIndex);
                          return (
                            <div
                              key={account.id}
                              className="flex items-center justify-between py-2.5 px-4 bg-bg-secondary rounded-lg"
                            >
                              <div className="flex items-center gap-3 min-w-0">
                                <span
                                  className="w-2.5 h-2.5 rounded-full shrink-0"
                                  style={{ backgroundColor: current.hex }}
                                  aria-hidden="true"
                                />
                              <div className="min-w-0">
                                <div className="text-sm font-medium text-text-primary flex items-center gap-2">
                                  {account.displayName ?? account.email}
                                  <span className="text-[0.6rem] font-medium px-1.5 py-0.5 rounded-full bg-bg-tertiary text-text-tertiary">
                                    {providerLabel}
                                  </span>
                                </div>
                                <div className="text-xs text-text-tertiary">
                                  {account.email}
                                </div>
                                <AccountColorPicker
                                  accountId={account.id}
                                  selectedId={current.id}
                                />
                                {/* Whether this server is pushing to us right now — the
                                    setting only says it was asked to */}
                                {imapIdle && (() => {
                                  const state = idleStatuses[account.id] ?? "off";
                                  const reason = idleReasons[account.id];
                                  const explanation =
                                    state === "connected"
                                      ? "The server is holding a connection open and will say the moment mail arrives."
                                      : state === "connecting"
                                        ? "Asking the server to hold a connection. Usually a few seconds."
                                        : state === "failed"
                                          ? explainIdleFailure(reason)
                                          : "Not being watched. This account still syncs on the timer.";
                                  return (
                                    <Tooltip content={explanation} placement="bottom">
                                      <div className="mt-1 flex items-center gap-1.5 text-[0.6875rem] cursor-default w-fit">
                                        {state === "connecting" ? (
                                          <Spinner size={11} label="Connecting" className="text-accent" />
                                        ) : (
                                          <span
                                            aria-hidden="true"
                                            className={`inline-block w-2 h-2 rounded-full ${
                                              state === "connected" ? "bg-success"
                                              : state === "failed" ? "bg-warning"
                                              : "bg-text-tertiary"
                                            }`}
                                          />
                                        )}
                                        <span className={
                                          state === "connected" ? "text-success"
                                          : state === "failed" ? "text-warning"
                                          : "text-text-tertiary"
                                        }>
                                          {describeIdleState(state)}
                                        </span>
                                      </div>
                                    </Tooltip>
                                  );
                                })()}
                              </div>
                              </div>
                              <div className="flex items-center gap-3">
                                {imapIdle && (
                                  <button
                                    onClick={async () => {
                                      setReconnecting((prev) => ({ ...prev, [account.id]: true }));
                                      try {
                                        const { reconnectAccount } = await import("@/services/imap/idleManager");
                                        await reconnectAccount(account.id);
                                      } finally {
                                        setReconnecting((prev) => ({ ...prev, [account.id]: false }));
                                      }
                                    }}
                                    disabled={reconnecting[account.id] || idleStatuses[account.id] === "connecting"}
                                    className="flex items-center gap-1 text-xs text-accent hover:text-accent-hover transition-colors disabled:opacity-50"
                                  >
                                    {(reconnecting[account.id] || idleStatuses[account.id] === "connecting") && (
                                      <Spinner size={11} label="Reconnecting" />
                                    )}
                                    Reconnect
                                  </button>
                                )}
                                <Tooltip
                                  content={
                                    reauthStatus[account.id] === "authorizing"
                                      ? "Waiting for the sign-in to finish in your browser. If the tab is gone, click again to start over."
                                      : "Sign in again to grant new permissions — needed once for instant delivery."
                                  }
                                  placement="bottom"
                                >
                                <button
                                  onClick={() => handleReauthorizeAccount(account.id, account.email)}
                                  className="flex items-center gap-1 text-xs text-accent hover:text-accent-hover transition-colors"
                                >
                                  {reauthStatus[account.id] === "authorizing" && <><Spinner size={11} label="Waiting for Google" />Waiting…</>}
                                  {reauthStatus[account.id] === "done" && "Done!"}
                                  {reauthStatus[account.id] === "error" && "Failed"}
                                  {(!reauthStatus[account.id] || reauthStatus[account.id] === "idle") && "Re-authorize"}
                                </button>
                                </Tooltip>
                                <button
                                  onClick={() => handleResyncAccount(account.id)}
                                  disabled={resyncStatus[account.id] === "syncing"}
                                  className="flex items-center gap-1 text-xs text-accent hover:text-accent-hover transition-colors disabled:opacity-50"
                                >
                                  {resyncStatus[account.id] === "syncing" && <><Spinner size={11} label="Resyncing" />Resyncing…</>}
                                  {resyncStatus[account.id] === "done" && "Done!"}
                                  {resyncStatus[account.id] === "error" && "Failed"}
                                  {(!resyncStatus[account.id] || resyncStatus[account.id] === "idle") && "Resync"}
                                </button>
                                <button
                                  onClick={() => handleRemoveAccount(account.id)}
                                  className="text-xs text-danger hover:text-danger/80 transition-colors"
                                >
                                  Remove
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </Section>

                  <Section title="Instant delivery">
                    <ToggleRow
                      label="Let servers push new mail"
                      description="Hold a connection open so the server says the moment something arrives, instead of being asked every minute. Falls back to the timer wherever a server refuses. Status is shown on each account above."
                      checked={imapIdle}
                      onToggle={async () => {
                        const next = !imapIdle;
                        setImapIdle(next);
                        await setSetting("imap_idle", next ? "true" : "false");
                        const { startIdleWatchers, stopIdleWatchers } =
                          await import("@/services/imap/idleManager");
                        if (next) await startIdleWatchers();
                        else await stopIdleWatchers();
                      }}
                    />
                  </Section>

                  {accounts.some((a) => a.provider === "caldav") && (
                    <Section title="Calendar Accounts">
                      <div className="space-y-2">
                        {accounts.filter((a) => a.provider === "caldav").map((account) => (
                          <div
                            key={account.id}
                            className="flex items-center justify-between py-2.5 px-4 bg-bg-secondary rounded-lg"
                          >
                            <div>
                              <div className="text-sm font-medium text-text-primary flex items-center gap-2">
                                {account.displayName ?? account.email}
                                <span className="text-[0.6rem] font-medium px-1.5 py-0.5 rounded-full bg-accent/10 text-accent">
                                  CalDAV
                                </span>
                              </div>
                              <div className="text-xs text-text-tertiary">
                                {account.email}
                              </div>
                            </div>
                            <button
                              onClick={() => handleRemoveAccount(account.id)}
                              className="text-xs text-danger hover:text-danger/80 transition-colors"
                            >
                              Remove
                            </button>
                          </div>
                        ))}
                      </div>
                    </Section>
                  )}

                  <SendAsAliasesSection />

                  <ImapCalDavSection />

                  <Section title="Google API">
                    <div className="space-y-3">
                      <TextField
                        label="Client ID"
                        size="md"
                        type="text"
                        value={clientId}
                        onChange={(e) => setClientId(e.target.value)}
                        placeholder="1234567890-abc.apps.googleusercontent.com"
                        {...(clientIdError ? { error: clientIdError } : {})}
                      />
                      <TextField
                        label="Client Secret"
                        size="md"
                        type="password"
                        value={clientSecret}
                        onChange={(e) => setClientSecret(e.target.value)}
                        placeholder="GOCSPX-..."
                        {...(clientSecretError ? { error: clientSecretError } : {})}
                      />
                      <Button
                        variant="primary"
                        size="md"
                        onClick={handleSaveApiSettings}
                        disabled={!clientId.trim() || !!clientIdError || !!clientSecretError}
                      >
                        {apiSettingsSaved ? "Saved!" : "Save"}
                      </Button>
                    </div>
                  </Section>

                  <Section title="Gmail push relay">
                    <div className="space-y-3">
                      <p className="text-xs text-text-tertiary">
                        Optional Gmail API push relay. This is separate from Instant delivery (IMAP IDLE). The URL and secret stay in your local settings; leave them blank to use normal sync polling.
                      </p>
                      <TextField
                        label="Relay URL"
                        size="md"
                        type="url"
                        value={gmailPushRelayUrl}
                        onChange={(e) => setGmailPushRelayUrl(e.target.value)}
                        placeholder="https://your-relay.example.com"
                      />
                      <TextField
                        label="Pub/Sub topic"
                        size="md"
                        value={gmailPushTopicName}
                        onChange={(e) => setGmailPushTopicName(e.target.value)}
                        placeholder="projects/PROJECT_ID/topics/sndmail-gmail"
                      />
                      <TextField
                        label="Relay secret"
                        size="md"
                        type="password"
                        value={gmailPushRelaySecret}
                        onChange={(e) => setGmailPushRelaySecret(e.target.value)}
                        placeholder="Bearer secret configured on the relay"
                      />
                      <div className="rounded-md border border-border-primary bg-bg-secondary px-3 py-2 text-xs text-text-secondary">
                        <div className="flex items-center justify-between gap-3">
                          <span>
                            Gmail relay: {gmailPushRelayStatus.state === "connected"
                              ? "connected"
                              : gmailPushRelayStatus.state === "connecting"
                                ? "connecting..."
                                : gmailPushRelayStatus.state === "error"
                                  ? "error"
                                  : "not checked"}
                          </span>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={handleProbeGmailPushRelay}
                            disabled={gmailPushRelayProbing}
                            icon={<RefreshCw size={13} className={gmailPushRelayProbing ? "animate-spin" : ""} />}
                          >
                            {gmailPushRelayProbing ? "Checking..." : "Check relay"}
                          </Button>
                        </div>
                        {gmailPushRelayStatus.attempted > 0 && (
                          <p className="mt-1">
                            Watches registered: {gmailPushRelayStatus.registered.length}/{gmailPushRelayStatus.attempted}
                          </p>
                        )}
                        {gmailPushRelayStatus.registered.length > 0 && (
                          <p className="mt-1 text-success">
                            Registered: {gmailPushRelayStatus.registered.map((registration) => registration.email).join(", ")}
                          </p>
                        )}
                        {gmailPushRelayStatus.registered.length === 0 && gmailPushRelayStatus.server && gmailPushRelayStatus.server.registrations.length > 0 && (
                          <p className="mt-1 text-success">
                            Relay registered: {gmailPushRelayStatus.server.registrations.map((registration) => registration.email).join(", ")}
                          </p>
                        )}
                        {gmailPushRelayStatus.failures.length > 0 && (
                          <p className="mt-1 text-danger">
                            Failed: {gmailPushRelayStatus.failures.map((failure) => `${failure.email} (${failure.message})`).join(", ")}
                          </p>
                        )}
                        {gmailPushRelayStatus.server && (
                          <p className="mt-1">
                            Relay sees {gmailPushRelayStatus.server.registrationCount} registered watch{gmailPushRelayStatus.server.registrationCount === 1 ? "" : "es"} and {gmailPushRelayStatus.server.connectedClients} listener{gmailPushRelayStatus.server.connectedClients === 1 ? "" : "s"}.
                          </p>
                        )}
                        {gmailPushRelayProbeError && <p className="mt-1 text-danger">Probe failed: {gmailPushRelayProbeError}</p>}
                      </div>
                      <Button variant="secondary" size="md" onClick={handleSaveGmailPushRelay}>
                        {gmailPushRelaySaved ? "Saved!" : "Save relay"}
                      </Button>
                    </div>
                  </Section>

                  <Section title="Sync">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-text-secondary">
                        Check for new mail
                      </span>
                      <Button
                        variant="primary"
                        size="md"
                        icon={<RefreshCw size={14} className={isSyncing ? "animate-spin" : ""} />}
                        onClick={handleManualSync}
                        disabled={isSyncing || accounts.length === 0}
                      >
                        {syncOperation === "sync" ? "Checking mail..." : "Sync now"}
                      </Button>
                    </div>
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="text-sm text-text-secondary">
                          Full resync
                        </span>
                        <p className="text-xs text-text-tertiary mt-0.5">
                          Re-download all emails from scratch
                        </p>
                      </div>
                      <Button
                        variant="secondary"
                        size="md"
                        icon={<RefreshCw size={14} className={isSyncing ? "animate-spin" : ""} />}
                        onClick={handleForceFullSync}
                        disabled={isSyncing || accounts.length === 0}
                        className="bg-bg-tertiary text-text-primary border border-border-primary"
                      >
                        {syncOperation === "resync" ? "Re-syncing..." : "Full resync"}
                      </Button>
                    </div>
                  </Section>

                  <Section title="Sync Period">
                    <SettingRow label="Sync emails from">
                      <select
                        value={syncPeriodDays}
                        onChange={async (e) => {
                          const val = e.target.value;
                          setSyncPeriodDays(val);
                          await setSetting("sync_period_days", val);
                        }}
                        className="w-48 bg-bg-tertiary text-text-primary text-sm px-3 py-1.5 rounded-md border border-border-primary focus:border-accent outline-none"
                      >
                        <option value="30">Last 30 days</option>
                        <option value="90">Last 90 days</option>
                        <option value="180">Last 180 days</option>
                        <option value="365">Last 1 year</option>
                      </select>
                    </SettingRow>
                    <p className="text-xs text-text-tertiary">
                      Changes apply on the next full resync.
                    </p>
                  </Section>

                  <SyncOfflineSection />
                </>
              )}

              {activeTab === "shortcuts" && (
                <ShortcutsTab />
              )}

              {activeTab === "ai" && (
                <>
                  <Section title="Provider">
                    <p className="text-xs text-text-tertiary mb-3">
                      Choose which AI provider to use for summarization, compose assistance, and smart categorization.
                    </p>
                    <SettingRow label="AI Provider">
                      <select
                        value={aiProvider}
                        onChange={async (e) => {
                          const val = e.target.value as "claude" | "openai" | "gemini" | "ollama" | "copilot";
                          setAiProvider(val);
                          setAiTestResult(null);
                          await setSetting("ai_provider", val);
                          const { clearProviderClients } = await import("@/services/ai/providerManager");
                          clearProviderClients();
                        }}
                        className="w-48 bg-bg-tertiary text-text-primary text-sm px-3 py-1.5 rounded-md border border-border-primary focus:border-accent outline-none"
                      >
                        <option value="claude">Claude (Anthropic)</option>
                        <option value="openai">OpenAI</option>
                        <option value="gemini">Gemini (Google)</option>
                        <option value="ollama">Local AI (Ollama / LMStudio)</option>
                        <option value="copilot">GitHub Copilot</option>
                      </select>
                    </SettingRow>
                    <p className="text-xs text-text-tertiary">
                      {aiProvider === "claude" && `Uses ${PROVIDER_MODELS.claude.find((m) => m.id === claudeModel)?.label ?? claudeModel}.`}
                      {aiProvider === "openai" && `Uses ${PROVIDER_MODELS.openai.find((m) => m.id === openaiModel)?.label ?? openaiModel}.`}
                      {aiProvider === "gemini" && `Uses ${PROVIDER_MODELS.gemini.find((m) => m.id === geminiModel)?.label ?? geminiModel}.`}
                      {aiProvider === "ollama" && "Connect to a local Ollama or LMStudio server. No API key required."}
                      {aiProvider === "copilot" && `Uses ${PROVIDER_MODELS.copilot.find((m) => m.id === copilotModel)?.label ?? copilotModel}. Requires a GitHub PAT with models:read permission.`}
                    </p>
                  </Section>

                  {aiProvider === "ollama" ? (
                    <Section title="Local Server">
                      <div className="space-y-3">
                        <TextField
                          label="Server URL"
                          size="md"
                          value={ollamaServerUrl}
                          onChange={(e) => setOllamaServerUrl(e.target.value)}
                          placeholder="http://localhost:11434"
                        />
                        <TextField
                          label="Model Name"
                          size="md"
                          value={ollamaModel}
                          onChange={(e) => setOllamaModel(e.target.value)}
                          placeholder="llama3.2"
                        />
                        <div className="flex items-center gap-2">
                          <Button
                            variant="primary"
                            size="md"
                            onClick={async () => {
                              await setSetting("ollama_server_url", ollamaServerUrl.trim());
                              await setSetting("ollama_model", ollamaModel.trim());
                              const { clearProviderClients } = await import("@/services/ai/providerManager");
                              clearProviderClients();
                              setAiKeySaved(true);
                              setTimeout(() => setAiKeySaved(false), 2000);
                            }}
                            disabled={!ollamaServerUrl.trim() || !ollamaModel.trim()}
                          >
                            {aiKeySaved ? "Saved!" : "Save"}
                          </Button>
                          <Button
                            variant="secondary"
                            size="md"
                            onClick={async () => {
                              setAiTesting(true);
                              setAiTestResult(null);
                              try {
                                const { testConnection } = await import("@/services/ai/aiService");
                                const ok = await testConnection();
                                setAiTestResult(ok ? "success" : "fail");
                              } catch {
                                setAiTestResult("fail");
                              } finally {
                                setAiTesting(false);
                              }
                            }}
                            disabled={!ollamaServerUrl.trim() || !ollamaModel.trim() || aiTesting}
                            className="bg-bg-tertiary text-text-primary border border-border-primary"
                          >
                            {aiTesting ? "Testing..." : "Test Connection"}
                          </Button>
                          {aiTestResult === "success" && (
                            <span className="text-xs text-success">Connected!</span>
                          )}
                          {aiTestResult === "fail" && (
                            <span className="text-xs text-danger">Connection failed</span>
                          )}
                        </div>
                      </div>
                    </Section>
                  ) : (
                    <Section title="API Key">
                      <div className="space-y-3">
                        <TextField
                          label={
                            aiProvider === "claude" ? "Anthropic API Key"
                            : aiProvider === "openai" ? "OpenAI API Key"
                            : aiProvider === "copilot" ? "GitHub Personal Access Token"
                            : "Google AI API Key"
                          }
                          size="md"
                          type="password"
                          value={
                            aiProvider === "claude" ? claudeApiKey
                            : aiProvider === "openai" ? openaiApiKey
                            : aiProvider === "copilot" ? copilotApiKey
                            : geminiApiKey
                          }
                          onChange={(e) => {
                            if (aiProvider === "claude") setClaudeApiKey(e.target.value);
                            else if (aiProvider === "openai") setOpenaiApiKey(e.target.value);
                            else if (aiProvider === "copilot") setCopilotApiKey(e.target.value);
                            else setGeminiApiKey(e.target.value);
                          }}
                          placeholder={
                            aiProvider === "claude" ? "sk-ant-..."
                            : aiProvider === "openai" ? "sk-..."
                            : aiProvider === "copilot" ? "ghp_..."
                            : "AI..."
                          }
                        />
                        <SettingRow label="Model">
                          <select
                            value={
                              aiProvider === "claude" ? claudeModel
                              : aiProvider === "openai" ? openaiModel
                              : aiProvider === "copilot" ? copilotModel
                              : geminiModel
                            }
                            onChange={async (e) => {
                              const val = e.target.value;
                              const modelSettingMap = {
                                claude: "claude_model",
                                openai: "openai_model",
                                gemini: "gemini_model",
                                copilot: "copilot_model",
                              } as const;
                              if (aiProvider === "claude") setClaudeModel(val);
                              else if (aiProvider === "openai") setOpenaiModel(val);
                              else if (aiProvider === "copilot") setCopilotModel(val);
                              else setGeminiModel(val);
                              await setSetting(modelSettingMap[aiProvider], val);
                              const { clearProviderClients } = await import("@/services/ai/providerManager");
                              clearProviderClients();
                            }}
                            className="w-48 bg-bg-tertiary text-text-primary text-sm px-3 py-1.5 rounded-md border border-border-primary focus:border-accent outline-none"
                          >
                            {PROVIDER_MODELS[aiProvider].map((m) => (
                              <option key={m.id} value={m.id}>{m.label}</option>
                            ))}
                          </select>
                        </SettingRow>
                        <div className="flex items-center gap-2">
                          <Button
                            variant="primary"
                            size="md"
                            onClick={async () => {
                              const keySettingMap = {
                                claude: "claude_api_key",
                                openai: "openai_api_key",
                                gemini: "gemini_api_key",
                                copilot: "copilot_api_key",
                              } as const;
                              const keyValue =
                                aiProvider === "claude" ? claudeApiKey.trim()
                                : aiProvider === "openai" ? openaiApiKey.trim()
                                : aiProvider === "copilot" ? copilotApiKey.trim()
                                : geminiApiKey.trim();
                              if (keyValue) {
                                await setSecureSetting(keySettingMap[aiProvider], keyValue);
                                const { clearProviderClients } = await import("@/services/ai/providerManager");
                                clearProviderClients();
                              }
                              setAiKeySaved(true);
                              setTimeout(() => setAiKeySaved(false), 2000);
                            }}
                            disabled={
                              !(aiProvider === "claude" ? claudeApiKey.trim()
                              : aiProvider === "openai" ? openaiApiKey.trim()
                              : aiProvider === "copilot" ? copilotApiKey.trim()
                              : geminiApiKey.trim())
                            }
                          >
                            {aiKeySaved ? "Saved!" : "Save Key"}
                          </Button>
                          <Button
                            variant="secondary"
                            size="md"
                            onClick={async () => {
                              setAiTesting(true);
                              setAiTestResult(null);
                              try {
                                const { testConnection } = await import("@/services/ai/aiService");
                                const ok = await testConnection();
                                setAiTestResult(ok ? "success" : "fail");
                              } catch {
                                setAiTestResult("fail");
                              } finally {
                                setAiTesting(false);
                              }
                            }}
                            disabled={
                              !(aiProvider === "claude" ? claudeApiKey.trim()
                              : aiProvider === "openai" ? openaiApiKey.trim()
                              : aiProvider === "copilot" ? copilotApiKey.trim()
                              : geminiApiKey.trim()) || aiTesting
                            }
                            className="bg-bg-tertiary text-text-primary border border-border-primary"
                          >
                            {aiTesting ? "Testing..." : "Test Connection"}
                          </Button>
                          {aiTestResult === "success" && (
                            <span className="text-xs text-success">Connected!</span>
                          )}
                          {aiTestResult === "fail" && (
                            <span className="text-xs text-danger">Connection failed</span>
                          )}
                        </div>
                      </div>
                    </Section>
                  )}

                  <Section title="Features">
                    <ToggleRow
                      label="Enable AI features"
                      description="Master toggle for all AI functionality"
                      checked={aiEnabled}
                      onToggle={async () => {
                        const newVal = !aiEnabled;
                        setAiEnabled(newVal);
                        await setSetting("ai_enabled", newVal ? "true" : "false");
                      }}
                    />
                    <ToggleRow
                      label="Auto-categorize inbox"
                      description="Use AI to refine rule-based categorization"
                      checked={aiAutoCategorize}
                      onToggle={async () => {
                        const newVal = !aiAutoCategorize;
                        setAiAutoCategorize(newVal);
                        await setSetting("ai_auto_categorize", newVal ? "true" : "false");
                      }}
                    />
                    <ToggleRow
                      label="Auto-summarize threads"
                      description="Show AI summaries on multi-message threads"
                      checked={aiAutoSummarize}
                      onToggle={async () => {
                        const newVal = !aiAutoSummarize;
                        setAiAutoSummarize(newVal);
                        await setSetting("ai_auto_summarize", newVal ? "true" : "false");
                      }}
                    />
                  </Section>

                  <Section title="Auto-Draft Replies">
                    <ToggleRow
                      label="Auto-draft replies"
                      description="Pre-populate the reply editor with an AI-generated draft"
                      checked={aiAutoDraftEnabled}
                      onToggle={async () => {
                        const newVal = !aiAutoDraftEnabled;
                        setAiAutoDraftEnabled(newVal);
                        await setSetting("ai_auto_draft_enabled", newVal ? "true" : "false");
                      }}
                    />
                    <ToggleRow
                      label="Learn writing style"
                      description="Analyze your sent emails to match your tone and voice"
                      checked={aiWritingStyleEnabled}
                      onToggle={async () => {
                        const newVal = !aiWritingStyleEnabled;
                        setAiWritingStyleEnabled(newVal);
                        await setSetting("ai_writing_style_enabled", newVal ? "true" : "false");
                      }}
                    />
                    {aiWritingStyleEnabled && (
                      <div className="flex items-center justify-between">
                        <div>
                          <span className="text-sm text-text-secondary">Writing style profile</span>
                          <p className="text-xs text-text-tertiary mt-0.5">
                            Reanalyze your writing style from recent sent emails
                          </p>
                        </div>
                        <Button
                          variant="secondary"
                          size="md"
                          onClick={async () => {
                            setStyleAnalyzing(true);
                            setStyleAnalyzeDone(false);
                            try {
                              const activeId = accounts.find((a) => a.isActive)?.id;
                              if (activeId) {
                                const { refreshWritingStyle } = await import("@/services/ai/writingStyleService");
                                await refreshWritingStyle(activeId);
                                setStyleAnalyzeDone(true);
                                setTimeout(() => setStyleAnalyzeDone(false), 3000);
                              }
                            } catch (err) {
                              console.error("Style analysis failed:", err);
                            } finally {
                              setStyleAnalyzing(false);
                            }
                          }}
                          disabled={styleAnalyzing}
                          className="bg-bg-tertiary text-text-primary border border-border-primary"
                        >
                          {styleAnalyzing ? "Analyzing..." : styleAnalyzeDone ? "Done!" : "Reanalyze"}
                        </Button>
                      </div>
                    )}
                  </Section>

                  <Section title="Categories">
                    <p className="text-xs text-text-tertiary mb-1">
                      Incoming emails are automatically sorted using rule-based heuristics (Gmail labels, sender domain, headers). When AI is enabled, it refines results for better accuracy.
                    </p>
                    <p className="text-xs text-text-tertiary mb-3">
                      Enable auto-archive to skip the inbox for specific categories.
                    </p>
                    {(["Updates", "Promotions", "Social", "Newsletters"] as const).map((cat) => (
                      <ToggleRow
                        key={cat}
                        label={`Auto-archive ${cat}`}
                        description={`Skip inbox for ${cat.toLowerCase()} emails`}
                        checked={autoArchiveCategories.has(cat)}
                        onToggle={async () => {
                          const next = new Set(autoArchiveCategories);
                          if (next.has(cat)) next.delete(cat);
                          else next.add(cat);
                          setAutoArchiveCategories(next);
                          await setSetting("auto_archive_categories", [...next].join(","));
                        }}
                      />
                    ))}
                  </Section>

                  <Section title="Bundling & Delivery Schedules">
                    <p className="text-xs text-text-tertiary mb-3">
                      Collapse categories into a single row in the inbox. Optionally set a delivery schedule to batch emails.
                    </p>
                    <BundleSettings />
                  </Section>
                </>
              )}

              {activeTab === "about" && (
                <>
                  <DeveloperTab />
                  <AboutTab />
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {showAddAccount && (
        <AddAccount
          zIndex="z-[60]"
          onClose={() => setShowAddAccount(false)}
          onSuccess={async () => {
            setShowAddAccount(false);
            await refreshAfterAccountAdded();
          }}
        />
      )}
    </div>
  );
}

/**
 * Colour swatches for one account. The colour identifies the mailbox in the
 * unified inbox, where every thread otherwise looks alike.
 */
function AccountColorPicker({
  accountId,
  selectedId,
}: {
  accountId: string;
  selectedId: string;
}) {
  const setAccountColor = useAccountStore((s) => s.setAccountColor);

  const pick = async (colorId: string) => {
    setAccountColor(accountId, colorId);
    await updateAccountColor(accountId, colorId);
  };

  return (
    <div className="flex items-center gap-1.5 mt-1.5">
      {ACCOUNT_COLORS.map((color) => {
        const isSelected = color.id === selectedId;
        return (
          <Tooltip content={color.label}><button
            key={color.id}
            onClick={() => pick(color.id)}

            aria-label={`Use ${color.label} for this account`}
            aria-pressed={isSelected}
            className={`w-4 h-4 rounded-full transition-transform hover:scale-110 ${
              isSelected ? "ring-2 ring-offset-2 ring-offset-bg-secondary ring-text-tertiary" : ""
            }`}
            style={{ backgroundColor: color.hex }}
          /></Tooltip>
        );
      })}
    </div>
  );
}

export function SendAsAliasesSection() {
  const accounts = useAccountStore((s) => s.accounts);
  const [aliases, setAliases] = useState<SendAsAlias[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const reloadAliases = useCallback(async (accountId: string) => {
    const dbAliases = await getAliasesForAccount(accountId);
    setAliases(dbAliases.map(mapDbAlias));
  }, []);

  useEffect(() => {
    const activeAccount = accounts.find((a) => a.isActive);
    if (!activeAccount || activeAccount.provider !== "gmail_api") {
      setAliases([]);
      return;
    }
    let cancelled = false;
    getAliasesForAccount(activeAccount.id).then((dbAliases) => {
      if (cancelled) return;
      setAliases(dbAliases.map(mapDbAlias));
    });
    return () => { cancelled = true; };
  }, [accounts, reloadAliases]);

  const activeAccount = accounts.find((a) => a.isActive);

  const handleRefresh = async () => {
    if (!activeAccount || activeAccount.provider !== "gmail_api") return;
    setRefreshing(true);
    setLoadError(null);
    try {
      const client = await getGmailClient(activeAccount.id);
      await fetchSendAsAliases(client, activeAccount.id);
      await reloadAliases(activeAccount.id);
      notify("success", "Aliases refreshed");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLoadError(message);
      reportError("Could not refresh Gmail aliases", error);
    } finally {
      setRefreshing(false);
    }
  };

  const handleSetDefault = async (alias: SendAsAlias) => {
    if (!activeAccount) return;
    await setDefaultAlias(activeAccount.id, alias.id);
    setAliases((prev) =>
      prev.map((a) => ({
        ...a,
        isDefault: a.id === alias.id,
      })),
    );
  };

  return (
    <Section title="Send-As Aliases">
      {activeAccount?.provider === "gmail_api" ? (
        <>
          <p className="text-xs text-text-tertiary mb-3">
            Add an address in Google Admin as an alternate email address, or in Gmail under Settings → Accounts → Send mail as. Complete Gmail’s verification, then refresh here. Only verified aliases are available to send from.
          </p>
          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshing}
            className="mb-3 flex items-center gap-1.5 text-xs text-accent hover:text-accent-hover disabled:opacity-50"
          >
            <RefreshCw size={13} className={refreshing ? "animate-spin" : ""} />
            {refreshing ? "Refreshing…" : "Refresh aliases"}
          </button>
          {loadError && (loadError.includes("403") || loadError.toLowerCase().includes("reauthorize")) && (
            <p role="alert" className="text-xs text-warning mb-3">
              Gmail denied access to send-as settings. Re-authorize this Gmail account in Settings → Accounts, then try again. ({loadError})
            </p>
          )}
        </>
      ) : (
        <p className="text-xs text-text-tertiary mb-3">Send-as aliases are available for Gmail accounts.</p>
      )}
      {aliases.length === 0 ? (
        <p className="text-sm text-text-tertiary">
          No aliases found. Add and verify an address with Google, then refresh aliases.
        </p>
      ) : (
        <div className="space-y-2">
          {aliases.map((alias) => (
            <div
              key={alias.id}
              className="flex items-center justify-between py-2.5 px-4 bg-bg-secondary rounded-lg"
            >
              <div className="flex items-center gap-3 min-w-0">
                <Mail size={15} className="text-text-tertiary shrink-0" />
                <div className="min-w-0">
                  <div className="text-sm font-medium text-text-primary truncate">
                    {alias.displayName ? `${alias.displayName} <${alias.email}>` : alias.email}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    {alias.isPrimary && (
                      <span className="text-[0.625rem] bg-accent/15 text-accent px-1.5 py-0.5 rounded-full">
                        Primary
                      </span>
                    )}
                    {alias.isDefault && (
                      <span className="text-[0.625rem] bg-success/15 text-success px-1.5 py-0.5 rounded-full">
                        Default
                      </span>
                    )}
                    {alias.verificationStatus !== "accepted" && (
                      <span className="text-[0.625rem] bg-warning/15 text-warning px-1.5 py-0.5 rounded-full">
                        {alias.verificationStatus}
                      </span>
                    )}
                  </div>
                </div>
              </div>
              {!alias.isDefault && (
                <button
                  onClick={() => handleSetDefault(alias)}
                  className="text-xs text-accent hover:text-accent-hover transition-colors shrink-0 ml-3"
                >
                  Set as default
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

function SyncOfflineSection() {
  const [pendingCount, setPendingCount] = useState(0);
  const [failedCount, setFailedCount] = useState(0);
  const [loading, setLoading] = useState(false);

  const loadCounts = useCallback(async () => {
    const { getPendingOpsCount, getFailedOpsCount } = await import("@/services/db/pendingOperations");
    setPendingCount(await getPendingOpsCount());
    setFailedCount(await getFailedOpsCount());
  }, []);

  useEffect(() => {
    loadCounts();
  }, [loadCounts]);

  const handleRetryFailed = async () => {
    setLoading(true);
    try {
      const { retryFailedOperations } = await import("@/services/db/pendingOperations");
      await retryFailedOperations();
      await loadCounts();
    } finally {
      setLoading(false);
    }
  };

  const handleClearFailed = async () => {
    setLoading(true);
    try {
      const { clearFailedOperations } = await import("@/services/db/pendingOperations");
      await clearFailedOperations();
      await loadCounts();
    } finally {
      setLoading(false);
    }
  };

  return (
    <Section title="Sync & Offline">
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <span className="text-sm text-text-secondary">Pending operations</span>
            <p className="text-xs text-text-tertiary mt-0.5">
              Changes waiting to sync to the server
            </p>
          </div>
          <span className="text-sm font-mono text-text-primary">{pendingCount}</span>
        </div>

        <div className="flex items-center justify-between">
          <div>
            <span className="text-sm text-text-secondary">Failed operations</span>
            <p className="text-xs text-text-tertiary mt-0.5">
              Changes that could not be synced after multiple retries
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-mono text-text-primary">{failedCount}</span>
            {failedCount > 0 && (
              <>
                <button
                  onClick={handleRetryFailed}
                  disabled={loading}
                  className="text-xs text-accent hover:text-accent-hover transition-colors disabled:opacity-50"
                >
                  Retry
                </button>
                <button
                  onClick={handleClearFailed}
                  disabled={loading}
                  className="text-xs text-danger hover:opacity-80 transition-colors disabled:opacity-50"
                >
                  Clear
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </Section>
  );
}

function DeveloperTab() {
  const [appVersion, setAppVersion] = useState("");
  const [tauriVersion, setTauriVersion] = useState("");
  const [webviewVersion, setWebviewVersion] = useState("");
  const [platformLabel, setPlatformLabel] = useState("...");

  useEffect(() => {
    async function load() {
      const { getVersion, getTauriVersion } = await import("@tauri-apps/api/app");
      setAppVersion(await getVersion());
      setTauriVersion(await getTauriVersion());

      // Extract WebView version from user agent
      const ua = navigator.userAgent;
      const edgMatch = /Edg\/(\S+)/.exec(ua);
      const chromeMatch = /Chrome\/(\S+)/.exec(ua);
      const webkitMatch = /AppleWebKit\/(\S+)/.exec(ua);
      setWebviewVersion(edgMatch?.[1] ?? chromeMatch?.[1] ?? webkitMatch?.[1] ?? "Unknown");

      // Detect platform via Tauri OS plugin (reliable native arch detection)
      const { platform, arch } = await import("@tauri-apps/plugin-os");
      const p = platform();
      const a = arch();
      const archLabel = a === "aarch64" || a === "arm" ? "ARM" : a === "x86_64" ? "x64" : a;
      if (p === "macos") {
        setPlatformLabel(a === "aarch64" ? "macOS (Apple Silicon)" : `macOS (${archLabel})`);
      } else if (p === "windows") {
        setPlatformLabel(`Windows (${archLabel})`);
      } else if (p === "linux") {
        setPlatformLabel(`Linux (${archLabel})`);
      } else {
        setPlatformLabel(`${p} (${archLabel})`);
      }

    }
    load();
  }, []);

  return (
    <>
      <Section title="App Info">
        <InfoRow label="App version" value={appVersion ? `${appVersion} (${FIX_NUMBER})` : "..."} />
        <InfoRow label="Tauri version" value={tauriVersion || "..."} />
        <InfoRow label="WebView version" value={webviewVersion || "..."} />
        <InfoRow label="Platform" value={platformLabel} />
      </Section>

      <Section title="Updates">
        <p className="text-sm text-text-secondary">
          {UPDATE_SOURCE_CONFIGURED
            ? "sndmail checks for signed updates in the background."
            : "Automatic updates are unavailable until a signed sndmail release source is configured."}
        </p>
      </Section>

      <Section title="Developer Tools">
        <div className="flex items-center justify-between">
          <div>
            <span className="text-sm text-text-secondary">Open DevTools</span>
            <p className="text-xs text-text-tertiary mt-0.5">
              Open the WebView developer tools inspector
            </p>
          </div>
          <Button
            variant="secondary"
            size="md"
            onClick={async () => {
              const { invoke } = await import("@tauri-apps/api/core");
              await invoke("open_devtools");
            }}
            className="bg-bg-tertiary text-text-primary border border-border-primary"
          >
            Open DevTools
          </Button>
        </div>
      </Section>
    </>
  );
}

function AboutTab() {
  const [appVersion, setAppVersion] = useState("");

  useEffect(() => {
    import("@tauri-apps/api/app").then(({ getVersion }) =>
      getVersion().then(setAppVersion),
    );
  }, []);

  const openExternal = async (url: string) => {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  };

  return (
    <>
      <Section title="sndmail">
        <div className="flex items-center gap-3 mb-2">
          <img src={appIcon} alt="sndmail" className="w-12 h-12 rounded-xl" />
          <div>
            <h3 className="text-base font-semibold text-text-primary">sndmail</h3>
            <p className="text-sm text-text-tertiary">
              {appVersion ? `Version ${appVersion}` : "Loading..."}
            </p>
          </div>
        </div>
        <p className="text-sm text-text-secondary leading-relaxed">
          A fast, open-source desktop email client built with privacy in mind. Your emails stay on your machine — no cloud, no tracking.
        </p>
      </Section>

      <Section title="Links">
        <div className="space-y-1">
          <button
            onClick={() => openExternal("https://github.com/ArneNostitz/sndmail")}
            className="flex items-center gap-3 w-full px-4 py-2.5 rounded-lg bg-bg-secondary hover:bg-bg-hover transition-colors text-left"
          >
            <Github size={16} className="text-text-tertiary shrink-0" />
            <div className="min-w-0 flex-1">
              <span className="text-sm text-text-primary">GitHub Repository</span>
            </div>
            <ExternalLink size={14} className="text-text-tertiary shrink-0" />
          </button>

        </div>
      </Section>

      <Section title="License">
        <div className="px-4 py-3 bg-bg-secondary rounded-lg">
          <div className="flex items-center gap-2 mb-2">
            <Scale size={15} className="text-text-tertiary" />
            <span className="text-sm font-medium text-text-primary">Apache License 2.0</span>
          </div>
          <p className="text-xs text-text-secondary leading-relaxed mb-3">
            Licensed under the Apache License, Version 2.0. You may obtain a copy of the License at{" "}
            <button
              onClick={() => openExternal("https://www.apache.org/licenses/LICENSE-2.0")}
              className="text-accent hover:text-accent-hover transition-colors"
            >
              apache.org/licenses/LICENSE-2.0
            </button>
          </p>
          <p className="text-xs text-text-tertiary leading-relaxed">
            Copyright 2025 sndmail. You may use, distribute, and modify this software under the terms of the Apache 2.0 license. This software is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND.
          </p>
        </div>
      </Section>

      <Section title="Attribution">
        <div className="px-4 py-3 bg-bg-secondary rounded-lg">
          <div className="flex items-center gap-2 mb-2">
            <GitFork size={15} className="text-text-tertiary" />
            <span className="text-sm font-medium text-text-primary">Third-party attribution</span>
          </div>
          <p className="text-xs text-text-secondary leading-relaxed">
            Third-party copyright and license notices are included in NOTICE.
          </p>
        </div>
      </Section>
    </>
  );
}


function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-text-secondary">{label}</span>
      <span className="text-sm text-text-primary font-mono">{value}</span>
    </div>
  );
}

function ShortcutsTab() {
  const keyMap = useShortcutStore((s) => s.keyMap);
  const setKey = useShortcutStore((s) => s.setKey);
  const resetKey = useShortcutStore((s) => s.resetKey);
  const resetAll = useShortcutStore((s) => s.resetAll);
  const defaults = getDefaultKeyMap();
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [composeShortcut, setComposeShortcut] = useState(DEFAULT_SHORTCUT);
  const [recordingGlobal, setRecordingGlobal] = useState(false);

  useEffect(() => {
    const current = getCurrentShortcut();
    if (current) setComposeShortcut(current);
  }, []);

  const handleGlobalRecord = useCallback((shortcut: string) => {
    setComposeShortcut(shortcut);
    setRecordingGlobal(false);
    registerComposeShortcut(shortcut).catch((err) => {
      console.error("Failed to register shortcut:", err);
    });
  }, []);

  const handleKeyRecord = useCallback((shortcut: string) => {
    if (!recordingId) return;
    setKey(recordingId, shortcut);
    setRecordingId(null);
  }, [recordingId, setKey]);

  useShortcutRecorder(recordingGlobal, handleGlobalRecord, "CmdOrCtrl");
  useShortcutRecorder(recordingId !== null, handleKeyRecord);

  const hasCustom = Object.entries(keyMap).some(([id, keys]) => defaults[id] !== keys);

  return (
    <>
      <Section title="Global Shortcut">
        <div className="flex items-center justify-between">
          <div>
            <span className="text-sm text-text-secondary">Quick compose</span>
            <p className="text-xs text-text-tertiary mt-0.5">
              Open compose window from any app
            </p>
          </div>
          <div className="flex items-center gap-2">
            <kbd className="text-xs bg-bg-tertiary px-2 py-1 rounded border border-border-primary font-mono">
              {composeShortcut}
            </kbd>
            <button
              onClick={() => {
                setRecordingId(null);
                setRecordingGlobal(true);
              }}
              onBlur={() => setRecordingGlobal(false)}
              className={`text-xs px-2.5 py-1 rounded-md transition-colors ${
                recordingGlobal
                  ? "bg-accent text-white"
                  : "bg-bg-tertiary text-text-secondary hover:text-text-primary border border-border-primary"
              }`}
            >
              {recordingGlobal ? "Press keys..." : "Change"}
            </button>
          </div>
        </div>
      </Section>

      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-text-tertiary">
          Click a shortcut to rebind it. Press any key or key combination to set.
        </p>
        {hasCustom && (
          <button
            onClick={resetAll}
            className="text-xs text-accent hover:text-accent-hover transition-colors shrink-0 ml-4"
          >
            Reset all
          </button>
        )}
      </div>
      {SHORTCUTS.map((section) => (
        <Section key={section.category} title={section.category}>
          <div className="space-y-1">
            {section.items.map((item) => {
              const currentKey = keyMap[item.id] ?? item.keys;
              const isDefault = currentKey === defaults[item.id];
              const isRecording = recordingId === item.id;

              return (
                <div
                  key={item.id}
                  className="flex items-center justify-between py-2 px-1"
                >
                  <span className="text-sm text-text-secondary">
                    {item.desc}
                  </span>
                  <div className="flex items-center gap-2 ml-4 shrink-0">
                    <button
                      onClick={() => {
                        setRecordingGlobal(false);
                        setRecordingId(isRecording ? null : item.id);
                      }}
                      onBlur={() => { if (isRecording) setRecordingId(null); }}
                      className={`text-xs px-2.5 py-1 rounded-md font-mono transition-colors ${
                        isRecording
                          ? "bg-accent text-white"
                          : "bg-bg-tertiary text-text-tertiary hover:text-text-primary border border-border-primary"
                      }`}
                    >
                      {isRecording ? "Press key..." : currentKey}
                    </button>
                    {!isDefault && (
                      <Tooltip content={`Reset to ${defaults[item.id]}`}><button
                        onClick={() => resetKey(item.id)}
                        className="text-xs text-text-tertiary hover:text-text-primary"

                      >
                        ×
                      </button></Tooltip>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </Section>
      ))}
    </>
  );
}

function ImapCalDavSection() {
  const accounts = useAccountStore((s) => s.accounts);
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const [account, setAccount] = useState<import("@/services/db/accounts").DbAccount | null>(null);

  useEffect(() => {
    if (!activeAccountId) return;
    import("@/services/db/accounts").then(({ getAccount }) => {
      getAccount(activeAccountId).then(setAccount);
    });
  }, [activeAccountId]);

  const activeUiAccount = accounts.find((a) => a.id === activeAccountId);
  const isImap = activeUiAccount?.provider === "imap";

  if (!isImap || !account) return null;

  return (
    <Section title="Calendar (CalDAV)">
      <CalDavSettingsInline account={account} onSaved={() => {
        // Reload account
        import("@/services/db/accounts").then(({ getAccount }) => {
          getAccount(account.id).then(setAccount);
        });
      }} />
    </Section>
  );
}

function CalDavSettingsInline({ account, onSaved }: { account: import("@/services/db/accounts").DbAccount; onSaved: () => void }) {
  const [CalDav, setCalDav] = useState<typeof import("@/components/settings/CalDavSettings").CalDavSettings | null>(null);

  useEffect(() => {
    import("@/components/settings/CalDavSettings").then((m) => setCalDav(() => m.CalDavSettings));
  }, []);

  if (!CalDav) return <div className="text-xs text-text-tertiary">Loading...</div>;

  return <CalDav account={account} onSaved={onSaved} />;
}

function SidebarNavEditor() {
  const sidebarNavConfig = useUIStore((s) => s.sidebarNavConfig);
  const setSidebarNavConfig = useUIStore((s) => s.setSidebarNavConfig);

  const items: SidebarNavItem[] = (() => {
    if (!sidebarNavConfig) return ALL_NAV_ITEMS.map((i) => ({ id: i.id, visible: true }));
    // Append any ALL_NAV_ITEMS entries missing from saved config (e.g. newly added sections)
    const savedIds = new Set(sidebarNavConfig.map((i) => i.id));
    const missing = ALL_NAV_ITEMS.filter((i) => !savedIds.has(i.id)).map((i) => ({ id: i.id, visible: true }));
    return [...sidebarNavConfig, ...missing];
  })();
  const navLookup = new Map(ALL_NAV_ITEMS.map((n) => [n.id, n]));

  const moveItem = (index: number, direction: -1 | 1) => {
    const next = [...items];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    const a = next[index];
    const b = next[target];
    if (!a || !b) return;
    next[index] = b;
    next[target] = a;
    setSidebarNavConfig(next);
  };

  const toggleItem = (index: number) => {
    const next = [...items];
    const current = next[index];
    // Inbox cannot be hidden
    if (!current || current.id === "inbox") return;
    next[index] = { ...current, visible: !current.visible };
    setSidebarNavConfig(next);
  };

  const resetToDefaults = () => {
    setSidebarNavConfig(ALL_NAV_ITEMS.map((i) => ({ id: i.id, visible: true })));
  };

  const isDefault =
    !sidebarNavConfig ||
    (items.length === ALL_NAV_ITEMS.length &&
      items.every((item, i) => item.id === ALL_NAV_ITEMS[i]?.id && item.visible));

  return (
    <Section title="Sidebar">
      <div className="space-y-1">
        {items.map((item, index) => {
          const nav = navLookup.get(item.id);
          if (!nav) return null;
          const Icon = nav.icon;
          const isInbox = item.id === "inbox";
          return (
            <div
              key={item.id}
              className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors ${
                item.visible ? "text-text-primary" : "text-text-tertiary"
              }`}
            >
              <Tooltip content="Move up"><button
                onClick={() => moveItem(index, -1)}
                disabled={index === 0}
                className="p-0.5 rounded text-text-tertiary hover:text-text-primary disabled:opacity-25 disabled:cursor-not-allowed transition-colors"

              >
                <ChevronUp size={14} />
              </button></Tooltip>
              <Tooltip content="Move down"><button
                onClick={() => moveItem(index, 1)}
                disabled={index === items.length - 1}
                className="p-0.5 rounded text-text-tertiary hover:text-text-primary disabled:opacity-25 disabled:cursor-not-allowed transition-colors"

              >
                <ChevronDown size={14} />
              </button></Tooltip>
              <Icon size={16} className="shrink-0 ml-1" />
              <span className="flex-1 truncate">{nav.label}</span>
              <Tooltip content={isInbox ? "Inbox is always visible" : item.visible ? "Hide" : "Show"}><button
                onClick={() => toggleItem(index)}
                disabled={isInbox}
                className={`relative w-10 h-5 rounded-full transition-colors shrink-0 ${
                  isInbox
                    ? "bg-accent/40 cursor-not-allowed"
                    : item.visible
                      ? "bg-accent cursor-pointer"
                      : "bg-bg-tertiary cursor-pointer"
                }`}

              >
                <span
                  className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                    item.visible ? "translate-x-5" : ""
                  }`}
                />
              </button></Tooltip>
            </div>
          );
        })}
      </div>
      {!isDefault && (
        <button
          onClick={resetToDefaults}
          className="flex items-center gap-1.5 text-xs text-accent hover:text-accent-hover mt-2 transition-colors"
        >
          <RotateCcw size={12} />
          Reset to defaults
        </button>
      )}
    </Section>
  );
}

function Section({
  title,
  children,
  action,
}: {
  title: string;
  children: React.ReactNode;
  /** Optional control rendered on the right of the section heading */
  action?: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-text-tertiary">
          {title}
        </h3>
        {action}
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function SettingRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between">
      <label className="text-sm text-text-secondary">{label}</label>
      {children}
    </div>
  );
}

/**
 * Whether notifications carry buttons here — and why not, if not — with a
 * way to see one. The backend is decided once, at start-up, by
 * notificationManager; only a bundled macOS build gets the native one.
 */
function NotificationButtonsRow({ backend }: { backend: NotificationBackend }) {
  const [os, setOs] = useState("");
  const failure = getNativeNotificationFailure();
  useEffect(() => {
    import("@tauri-apps/plugin-os")
      .then(({ platform }) => setOs(platform()))
      .catch(() => {});
  }, []);

  let note: string;
  if (backend === "native") {
    note =
      "Reply, Archive and Copy code sit on the notification. macOS hides a banner's buttons until you hover, so sndmail asks for the Alerts style; System Settings → Notifications → sndmail is where to change it.";
  } else if (backend === "plugin") {
    note =
      os === "macos"
        ? failure
          // The centre was there and said no — almost always an unsigned
          // build, which it cannot identify. Saying "development build"
          // here would send the user looking in the wrong place.
          ? `The macOS notification centre turned this build down (${failure}), so notifications are plain text. An app bundle has to be code-signed before the centre will accept it.`
          : "Buttons need the installed app: a development build runs outside an app bundle, which the macOS notification centre refuses, so notifications here are plain text."
        : "Notifications are plain text on this platform. The buttons live in sndmail's own toasts instead.";
  } else {
    note =
      "Notifications are off, or the system has not allowed them. On macOS, check System Settings → Notifications → sndmail.";
  }

  return (
    <div className="flex items-start justify-between gap-4">
      <p className="text-xs text-text-tertiary">{note}</p>
      <button
        onClick={async () => {
          const sent = await sendTestNotification();
          notify("info", sent === "off" ? "Notifications are off" : "Test notification sent");
        }}
        className="shrink-0 text-xs px-3 py-1.5 rounded-md bg-bg-tertiary hover:bg-bg-hover text-text-secondary border border-border-primary"
      >
        Send a test
      </button>
    </div>
  );
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function BundleSettings() {
  const accounts = useAccountStore((s) => s.accounts);
  const activeAccountId = accounts.find((a) => a.isActive)?.id;
  const [rules, setRules] = useState<Record<string, { bundled: boolean; delivery: boolean; days: number[]; hour: number; minute: number }>>({});

  useEffect(() => {
    if (!activeAccountId) return;
    import("@/services/db/bundleRules").then(async ({ getBundleRules }) => {
      const dbRules = await getBundleRules(activeAccountId);
      const map: typeof rules = {};
      for (const r of dbRules) {
        let schedule = { days: [6], hour: 9, minute: 0 };
        try {
          if (r.delivery_schedule) schedule = JSON.parse(r.delivery_schedule);
        } catch { /* use defaults */ }
        map[r.category] = {
          bundled: r.is_bundled === 1,
          delivery: r.delivery_enabled === 1,
          days: schedule.days,
          hour: schedule.hour,
          minute: schedule.minute,
        };
      }
      setRules(map);
    });
  }, [activeAccountId]);

  const saveRule = async (category: string, update: Partial<typeof rules[string]>) => {
    if (!activeAccountId) return;
    const current = rules[category] ?? { bundled: false, delivery: false, days: [6], hour: 9, minute: 0 };
    const merged = { ...current, ...update };
    setRules((prev) => ({ ...prev, [category]: merged }));
    const { setBundleRule } = await import("@/services/db/bundleRules");
    await setBundleRule(
      activeAccountId,
      category,
      merged.bundled,
      merged.delivery,
      merged.delivery ? { days: merged.days, hour: merged.hour, minute: merged.minute } : null,
    );
  };

  return (
    <div className="space-y-4">
      {(["Newsletters", "Promotions", "Social", "Updates"] as const).map((cat) => {
        const rule = rules[cat];
        return (
          <div key={cat} className="py-3 px-4 bg-bg-secondary rounded-lg space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-text-primary">{cat}</span>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-1.5 text-xs text-text-secondary">
                  <input
                    type="checkbox"
                    checked={rule?.bundled ?? false}
                    onChange={() => saveRule(cat, { bundled: !(rule?.bundled ?? false) })}
                    className="accent-accent"
                  />
                  Bundle
                </label>
                <label className="flex items-center gap-1.5 text-xs text-text-secondary">
                  <input
                    type="checkbox"
                    checked={rule?.delivery ?? false}
                    onChange={() => saveRule(cat, { delivery: !(rule?.delivery ?? false) })}
                    className="accent-accent"
                  />
                  Schedule
                </label>
              </div>
            </div>
            {rule?.delivery && (
              <div className="space-y-2 pt-1">
                <div className="flex gap-1">
                  {DAY_NAMES.map((name, idx) => (
                    <button
                      key={name}
                      onClick={() => {
                        const days = rule.days.includes(idx)
                          ? rule.days.filter((d) => d !== idx)
                          : [...rule.days, idx].sort();
                        saveRule(cat, { days });
                      }}
                      className={`w-8 h-7 text-[0.625rem] rounded transition-colors ${
                        rule.days.includes(idx)
                          ? "bg-accent text-white"
                          : "bg-bg-tertiary text-text-tertiary border border-border-primary"
                      }`}
                    >
                      {name}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-text-tertiary">at</span>
                  <input
                    type="time"
                    value={`${String(rule.hour).padStart(2, "0")}:${String(rule.minute).padStart(2, "0")}`}
                    onChange={(e) => {
                      const [h, m] = e.target.value.split(":").map(Number);
                      saveRule(cat, { hour: h ?? 9, minute: m ?? 0 });
                    }}
                    className="bg-bg-tertiary text-text-primary text-xs px-2 py-1 rounded border border-border-primary"
                  />
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onToggle,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <span className="text-sm text-text-secondary">{label}</span>
        {description && (
          <p className="text-xs text-text-tertiary mt-0.5">{description}</p>
        )}
      </div>
      <button
        onClick={onToggle}
        className={`w-10 h-5 rounded-full transition-colors relative shrink-0 ml-4 ${
          checked ? "bg-accent" : "bg-bg-tertiary"
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform shadow ${
            checked ? "translate-x-5" : ""
          }`}
        />
      </button>
    </div>
  );
}
