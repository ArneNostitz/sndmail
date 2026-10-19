import { useCallback, useEffect, useState } from "react";
import { Tooltip } from "@/components/ui/Tooltip";
import { SHORTCUTS, getDefaultKeyMap } from "@/constants/shortcuts";
import { useShortcutStore } from "@/stores/shortcutStore";
import { useShortcutRecorder } from "@/hooks/useShortcutRecorder";
import {
  registerComposeShortcut,
  getCurrentShortcut,
  DEFAULT_SHORTCUT,
} from "@/services/globalShortcut";
import { Section } from "../SettingsSection";

/** In-app key bindings, and the one shortcut that works outside the app. */
export function ShortcutsTab() {
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
                        aria-label={`Reset ${item.desc}`}
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
