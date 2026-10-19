import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/services/db/settings", () => ({
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  getSecureSetting: vi.fn(async () => null),
  setSecureSetting: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => false) }));
vi.mock("@/services/db/connection", () => ({
  getDb: vi.fn(async () => ({ select: vi.fn(async () => []) })),
}));
vi.mock("@tauri-apps/plugin-autostart", () => ({
  isEnabled: vi.fn(async () => true),
  enable: vi.fn(async () => {}),
  disable: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => null) }));
vi.mock("@/services/attachments/cacheManager", () => ({
  getCacheSize: vi.fn(async () => 1024 * 1024 * 12),
  clearAllCache: vi.fn(async () => {}),
}));

import { useUIStore } from "@/stores/uiStore";
import { setSetting } from "@/services/db/settings";
import { GeneralTab } from "./GeneralTab";

describe("GeneralTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUIStore.setState({
      theme: "dark",
      reduceMotion: false,
      emailDensity: "default",
      readingPanePosition: "right",
    });
  });

  it("persists the theme it is switched to", () => {
    render(<GeneralTab />);

    fireEvent.change(screen.getByDisplayValue("Dark"), { target: { value: "light" } });

    expect(useUIStore.getState().theme).toBe("light");
    expect(setSetting).toHaveBeenCalledWith("theme", "light");
  });

  it("loads and shows the cached attachment size", async () => {
    render(<GeneralTab />);

    await waitFor(() => expect(screen.getByText("12 MB used")).toBeInTheDocument());
  });

  it("flips reduce motion in the store", () => {
    render(<GeneralTab />);

    fireEvent.click(screen.getByRole("switch", { name: "Reduce motion" }));

    expect(useUIStore.getState().reduceMotion).toBe(true);
  });

  it("keeps the sidebar editor on the tab", () => {
    render(<GeneralTab />);

    expect(screen.getByText("Sidebar")).toBeInTheDocument();
  });
});
