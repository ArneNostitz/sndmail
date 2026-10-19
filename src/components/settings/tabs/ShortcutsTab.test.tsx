import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/services/db/settings", () => ({
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
}));
vi.mock("@/services/globalShortcut", () => ({
  DEFAULT_SHORTCUT: "CmdOrCtrl+Shift+M",
  getCurrentShortcut: vi.fn(() => "CmdOrCtrl+Shift+M"),
  registerComposeShortcut: vi.fn(async () => {}),
}));

import { useShortcutStore } from "@/stores/shortcutStore";
import { getDefaultKeyMap } from "@/constants/shortcuts";
import { ShortcutsTab } from "./ShortcutsTab";

describe("ShortcutsTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useShortcutStore.setState({ keyMap: getDefaultKeyMap() });
  });

  it("shows the global compose shortcut and the bindings", () => {
    render(<ShortcutsTab />);

    expect(screen.getByText("Quick compose")).toBeInTheDocument();
    expect(screen.getByText("CmdOrCtrl+Shift+M")).toBeInTheDocument();
    expect(screen.getByText("Navigation")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reset all" })).not.toBeInTheDocument();
  });

  it("offers a reset once a binding differs from its default", () => {
    useShortcutStore.setState({ keyMap: { ...getDefaultKeyMap(), "nav.next": "Ctrl+J" } });
    render(<ShortcutsTab />);

    fireEvent.click(screen.getByRole("button", { name: "Reset all" }));

    expect(useShortcutStore.getState().keyMap["nav.next"]).toBe("j");
  });
});
