import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("./tabs/GeneralTab", () => ({ GeneralTab: () => <div>general tab</div> }));
vi.mock("./tabs/NotificationsTab", () => ({ NotificationsTab: () => <div>notifications tab</div> }));
vi.mock("./tabs/ComposingTab", () => ({ ComposingTab: () => <div>composing tab</div> }));
vi.mock("./tabs/MailRulesTab", () => ({ MailRulesTab: () => <div>mail rules tab</div> }));
vi.mock("./tabs/PeopleTab", () => ({ PeopleTab: () => <div>people tab</div> }));
vi.mock("./tabs/PluginsTab", () => ({ PluginsTab: () => <div>plugins tab</div> }));
vi.mock("./tabs/AccountsTab", () => ({ AccountsTab: () => <div>accounts tab</div> }));
vi.mock("./tabs/ShortcutsTab", () => ({ ShortcutsTab: () => <div>shortcuts tab</div> }));
vi.mock("./tabs/IntelligenceTab", () => ({ IntelligenceTab: () => <div>ai tab</div> }));
vi.mock("./tabs/AboutTab", () => ({ AboutTab: () => <div>about tab</div> }));
vi.mock("./SemanticSearchSettings", () => ({
  SemanticSearchSettings: () => <div>semantic search tab</div>,
}));

import { useUIStore, SETTINGS_TABS } from "@/stores/uiStore";
import { SettingsPage } from "./SettingsPage";

describe("SettingsPage", () => {
  beforeEach(() => {
    useUIStore.setState({ settingsTab: "general", settingsOpen: true });
  });

  it("renders the tab the store points at", () => {
    render(<SettingsPage />);

    expect(screen.getByText("general tab")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "General" })).toBeInTheDocument();
  });

  it("has one nav entry and one component for every tab", () => {
    const { container } = render(<SettingsPage />);

    expect(container.querySelectorAll("nav button")).toHaveLength(SETTINGS_TABS.length);

    const content: Record<string, string> = {
      general: "general tab",
      notifications: "notifications tab",
      composing: "composing tab",
      "mail-rules": "mail rules tab",
      people: "people tab",
      plugins: "plugins tab",
      accounts: "accounts tab",
      shortcuts: "shortcuts tab",
      ai: "ai tab",
      "semantic-search": "semantic search tab",
      about: "about tab",
    };

    for (const tab of SETTINGS_TABS) {
      fireEvent.click(screen.getByRole("button", { name: labelFor(tab) }));
      expect(screen.getByText(content[tab]!)).toBeInTheDocument();
    }
  });

  it("closes settings", () => {
    render(<SettingsPage />);

    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));

    expect(useUIStore.getState().settingsOpen).toBe(false);
  });
});

/** Nav label as the shell renders it (the tab id differs for two of them). */
function labelFor(tab: string): string {
  const labels: Record<string, string> = {
    "mail-rules": "Mail Rules",
    "semantic-search": "Semantic Search",
    ai: "AI",
  };
  return labels[tab] ?? tab.charAt(0).toUpperCase() + tab.slice(1);
}
