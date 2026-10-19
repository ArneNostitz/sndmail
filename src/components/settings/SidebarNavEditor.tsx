import { ChevronDown, ChevronUp, RotateCcw } from "lucide-react";
import { Tooltip } from "@/components/ui/Tooltip";
import { ALL_NAV_ITEMS } from "@/components/layout/Sidebar";
import { useUIStore, type SidebarNavItem } from "@/stores/uiStore";
import { Section } from "./SettingsSection";
import { ToggleSwitch } from "./ToggleSwitch";

/** Which sidebar entries show, and in what order. */
export function SidebarNavEditor() {
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
                aria-label={`Move ${nav.label} up`}
                className="p-0.5 rounded text-text-tertiary hover:text-text-primary disabled:opacity-25 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronUp size={14} />
              </button></Tooltip>
              <Tooltip content="Move down"><button
                onClick={() => moveItem(index, 1)}
                disabled={index === items.length - 1}
                aria-label={`Move ${nav.label} down`}
                className="p-0.5 rounded text-text-tertiary hover:text-text-primary disabled:opacity-25 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronDown size={14} />
              </button></Tooltip>
              <Icon size={16} className="shrink-0 ml-1" />
              <span className="flex-1 truncate">{nav.label}</span>
              <Tooltip content={isInbox ? "Inbox is always visible" : item.visible ? "Hide" : "Show"}>
                <ToggleSwitch
                  checked={item.visible}
                  disabled={isInbox}
                  onChange={() => toggleItem(index)}
                  label={`Show ${nav.label}`}
                />
              </Tooltip>
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
