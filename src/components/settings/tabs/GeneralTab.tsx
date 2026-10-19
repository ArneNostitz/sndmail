import { useCallback, useEffect, useState } from "react";
import { Check } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { Tooltip } from "@/components/ui/Tooltip";
import { Button } from "@/components/ui/Button";
import { useUIStore } from "@/stores/uiStore";
import { useComposerStore } from "@/stores/composerStore";
import { reportError } from "@/stores/toastStore";
import { getSetting, setSetting } from "@/services/db/settings";
import { getDb } from "@/services/db/connection";
import { COLOR_THEMES } from "@/constants/themes";
import { Section } from "../SettingsSection";
import { SettingRow } from "../SettingRow";
import { SelectField } from "../SelectField";
import { ToggleRow } from "../ToggleRow";
import { SidebarNavEditor } from "../SidebarNavEditor";

/** Appearance, sidebar, startup, privacy and storage. */
export function GeneralTab() {
  const theme = useUIStore((s) => s.theme);
  const setTheme = useUIStore((s) => s.setTheme);
  const readingPanePosition = useUIStore((s) => s.readingPanePosition);
  const setReadingPanePosition = useUIStore((s) => s.setReadingPanePosition);
  const emailDensity = useUIStore((s) => s.emailDensity);
  const setEmailDensity = useUIStore((s) => s.setEmailDensity);
  const threadViewMode = useUIStore((s) => s.threadViewMode);
  const setThreadViewMode = useUIStore((s) => s.setThreadViewMode);
  const fontScale = useUIStore((s) => s.fontScale);
  const setFontScale = useUIStore((s) => s.setFontScale);
  const colorTheme = useUIStore((s) => s.colorTheme);
  const setColorTheme = useUIStore((s) => s.setColorTheme);
  const inboxViewMode = useUIStore((s) => s.inboxViewMode);
  const setInboxViewMode = useUIStore((s) => s.setInboxViewMode);
  const timeFormat = useUIStore((s) => s.timeFormat);
  const setTimeFormat = useUIStore((s) => s.setTimeFormat);
  const reduceMotion = useUIStore((s) => s.reduceMotion);
  const setReduceMotion = useUIStore((s) => s.setReduceMotion);

  const [blockRemoteImages, setBlockRemoteImages] = useState(true);
  const [phishingDetectionEnabled, setPhishingDetectionEnabled] = useState(true);
  const [phishingSensitivity, setPhishingSensitivity] = useState<"low" | "default" | "high">("default");
  const [autostartEnabled, setAutostartEnabled] = useState(false);
  const [backgroundWorkerEnabled, setBackgroundWorkerEnabled] = useState(true);
  const [backgroundWorkerReady, setBackgroundWorkerReady] = useState(false);
  const [workerNotificationPermission, setWorkerNotificationPermission] = useState<string | null>(null);
  // null = system Downloads folder
  const [downloadDirSetting, setDownloadDirSetting] = useState<string | null>(null);
  const [cacheMaxMb, setCacheMaxMb] = useState("500");
  const [cacheSizeMb, setCacheSizeMb] = useState<number | null>(null);
  const [clearingCache, setClearingCache] = useState(false);

  useEffect(() => {
    async function load() {
      setBlockRemoteImages((await getSetting("block_remote_images")) !== "false");
      setPhishingDetectionEnabled((await getSetting("phishing_detection_enabled")) !== "false");
      const phishingSens = await getSetting("phishing_sensitivity");
      if (phishingSens === "low" || phishingSens === "high") setPhishingSensitivity(phishingSens);
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

      // Load cache settings
      setCacheMaxMb((await getSetting("attachment_cache_max_mb")) ?? "500");
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

  return (
    <>
      <Section title="Appearance">
        <SettingRow label="Theme">
          <SelectField
            value={theme}
            options={[
              { value: "system", label: "System" },
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
            onChange={(val) => {
              setTheme(val);
              setSetting("theme", val);
            }}
          />
        </SettingRow>
        <SettingRow label="Reading pane">
          <SelectField
            value={readingPanePosition}
            options={[
              { value: "right", label: "Right" },
              { value: "bottom", label: "Bottom" },
              { value: "hidden", label: "Off" },
            ]}
            onChange={setReadingPanePosition}
          />
        </SettingRow>
        <SettingRow label="Email density">
          <SelectField
            value={emailDensity}
            options={[
              { value: "compact", label: "Compact" },
              { value: "default", label: "Default" },
              { value: "spacious", label: "Spacious" },
            ]}
            onChange={setEmailDensity}
          />
        </SettingRow>
        <SettingRow label="Thread layout">
          <SelectField
            value={threadViewMode}
            options={[
              { value: "classic", label: "Message list" },
              { value: "chat", label: "Chat bubbles" },
            ]}
            onChange={setThreadViewMode}
          />
        </SettingRow>
        <SettingRow label="Font size">
          <SelectField
            value={fontScale}
            options={[
              { value: "small", label: "Small" },
              { value: "default", label: "Default" },
              { value: "large", label: "Large" },
              { value: "xlarge", label: "Extra Large" },
            ]}
            onChange={setFontScale}
          />
        </SettingRow>
        <SettingRow label="Accent color">
          <div className="flex items-center gap-2">
            {COLOR_THEMES.map((t) => {
              const isSelected = colorTheme === t.id;
              return (
                <Tooltip content={t.name}><button
                  key={t.id}
                  onClick={() => setColorTheme(t.id)}
                  aria-label={`${t.name} accent`}
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
          <SelectField
            value={inboxViewMode}
            options={[
              { value: "unified", label: "Unified" },
              { value: "split", label: "Split (Categories)" },
            ]}
            onChange={setInboxViewMode}
          />
        </SettingRow>
        <SettingRow label="Time format">
          <SelectField
            value={timeFormat}
            options={[
              { value: "system", label: "Match system" },
              { value: "12h", label: "12-hour (1:30 PM)" },
              { value: "24h", label: "24-hour (13:30)" },
            ]}
            onChange={setTimeFormat}
          />
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
            <SelectField
              value={phishingSensitivity}
              options={[
                { value: "low", label: "Low (fewer warnings)" },
                { value: "default", label: "Default" },
                { value: "high", label: "High (more warnings)" },
              ]}
              onChange={async (val) => {
                setPhishingSensitivity(val);
                await setSetting("phishing_sensitivity", val);
              }}
            />
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
          <SelectField
            value={cacheMaxMb}
            options={[
              { value: "100", label: "100 MB" },
              { value: "250", label: "250 MB" },
              { value: "500", label: "500 MB" },
              { value: "1000", label: "1 GB" },
              { value: "2000", label: "2 GB" },
            ]}
            onChange={async (val) => {
              setCacheMaxMb(val);
              await setSetting("attachment_cache_max_mb", val);
            }}
          />
        </SettingRow>
      </Section>
    </>
  );
}
