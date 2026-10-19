import { useEffect, useState } from "react";
import { Tooltip } from "@/components/ui/Tooltip";
import { Button } from "@/components/ui/Button";
import { FIX_NUMBER, BUILD_INFO, formatBuildLabel, buildWebUrl } from "@/constants/build";
import { formatDateTime } from "@/utils/date";
import { useTimeFormat } from "@/hooks/useTimeFormat";
import { UPDATE_SOURCE_CONFIGURED } from "@/services/updateManager";
import { Section } from "./SettingsSection";

/** Versions, update source and the WebView inspector. */
export function DeveloperInfo() {
  useTimeFormat();
  const [appVersion, setAppVersion] = useState("");
  const [tauriVersion, setTauriVersion] = useState("");
  const [webviewVersion, setWebviewVersion] = useState("");
  const [platformLabel, setPlatformLabel] = useState("...");
  const buildUrl = buildWebUrl(BUILD_INFO);
  const openBuildUrl = async () => {
    if (!buildUrl) return;
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(buildUrl);
  };

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
        <InfoRow
          label="Build"
          value={formatBuildLabel(BUILD_INFO)}
          onClick={buildUrl ? openBuildUrl : undefined}
          hint={buildUrl ? "Open on GitHub" : undefined}
        />
        <InfoRow
          label="Built"
          value={
            BUILD_INFO.builtAt
              ? formatDateTime(BUILD_INFO.builtAt) + (BUILD_INFO.dirty ? " · modified" : "")
              : "unknown"
          }
        />
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

function InfoRow({
  label,
  value,
  onClick,
  hint,
}: {
  label: string;
  value: string;
  onClick?: () => void;
  hint?: string;
}) {
  const content = onClick ? (
    <button
      type="button"
      onClick={onClick}
      className="text-sm text-text-primary font-mono hover:text-accent transition-colors"
    >
      {value}
    </button>
  ) : (
    <span className="text-sm text-text-primary font-mono">{value}</span>
  );
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-text-secondary">{label}</span>
      {hint ? <Tooltip content={hint}>{content}</Tooltip> : content}
    </div>
  );
}
