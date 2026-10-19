import type { ComponentType } from "react";
import { X, Settings, PenLine, Bell, Filter, Users, UserCircle, Puzzle, Keyboard, Sparkles, Brain, Info, type LucideIcon } from "lucide-react";
import { Tooltip } from "@/components/ui/Tooltip";
import { useUIStore, type SettingsTab } from "@/stores/uiStore";
import { useShortcutStore } from "@/stores/shortcutStore";
import { SemanticSearchSettings } from "./SemanticSearchSettings";
import { GeneralTab } from "./tabs/GeneralTab";
import { NotificationsTab } from "./tabs/NotificationsTab";
import { ComposingTab } from "./tabs/ComposingTab";
import { MailRulesTab } from "./tabs/MailRulesTab";
import { PeopleTab } from "./tabs/PeopleTab";
import { PluginsTab } from "./tabs/PluginsTab";
import { AccountsTab } from "./tabs/AccountsTab";
import { ShortcutsTab } from "./tabs/ShortcutsTab";
import { IntelligenceTab } from "./tabs/IntelligenceTab";
import { AboutTab } from "./tabs/AboutTab";

const tabs: { id: SettingsTab; label: string; icon: LucideIcon }[] = [
  { id: "general", label: "General", icon: Settings },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "composing", label: "Composing", icon: PenLine },
  { id: "mail-rules", label: "Mail Rules", icon: Filter },
  { id: "people", label: "People", icon: Users },
  { id: "plugins", label: "Plugins", icon: Puzzle },
  { id: "accounts", label: "Accounts", icon: UserCircle },
  { id: "shortcuts", label: "Shortcuts", icon: Keyboard },
  { id: "ai", label: "AI", icon: Sparkles },
  { id: "semantic-search", label: "Semantic Search", icon: Brain },
  { id: "about", label: "About", icon: Info },
];

/** Each tab loads and saves its own settings — the shell only picks one. */
const tabContent: Record<SettingsTab, ComponentType> = {
  general: GeneralTab,
  notifications: NotificationsTab,
  composing: ComposingTab,
  "mail-rules": MailRulesTab,
  people: PeopleTab,
  plugins: PluginsTab,
  accounts: AccountsTab,
  shortcuts: ShortcutsTab,
  ai: IntelligenceTab,
  "semantic-search": SemanticSearchSettings,
  about: AboutTab,
};

/**
 * Settings shell: the tab list, the scroll container and the current tab.
 * Everything a tab owns — its settings, its state, its saving — lives in that
 * tab's component.
 */
export function SettingsPage() {
  const activeTab = useUIStore((s) => s.settingsTab);
  const setActiveTab = useUIStore((s) => s.setSettingsTab);
  const closeSettings = useUIStore((s) => s.closeSettings);
  const keyMap = useShortcutStore((s) => s.keyMap);
  const activeTabDef = tabs.find((t) => t.id === activeTab);
  const ActiveTab = tabContent[activeTab];

  return (
    <div className="flex flex-col h-full min-w-0 overflow-hidden bg-bg-primary/50">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-3 border-b border-border-primary shrink-0 bg-bg-primary/60 backdrop-blur-sm">
        <h1 className="text-base font-semibold text-text-primary">Settings</h1>
        <kbd className="text-[0.625rem] text-text-tertiary bg-bg-tertiary px-1.5 py-0.5 rounded font-mono">
          {keyMap["app.settings"] ?? "Ctrl+,"}
        </kbd>
        <Tooltip content={`Close settings (${keyMap["nav.escape"] ?? "Escape"})`}><button
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
              <ActiveTab />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
