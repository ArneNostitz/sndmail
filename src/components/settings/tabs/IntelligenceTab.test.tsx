import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const settings: Record<string, string> = {};
vi.mock("@/services/db/settings", () => ({
  getSetting: vi.fn(async (key: string) => settings[key] ?? null),
  setSetting: vi.fn(async (key: string, value: string) => {
    settings[key] = value;
  }),
  getSecureSetting: vi.fn(async () => null),
  setSecureSetting: vi.fn(async () => {}),
}));
vi.mock("@/services/ai/providerManager", () => ({ clearProviderClients: vi.fn() }));

import { useAccountStore } from "@/stores/accountStore";
import { setSetting } from "@/services/db/settings";
import { clearProviderClients } from "@/services/ai/providerManager";
import { IntelligenceTab } from "./IntelligenceTab";

describe("IntelligenceTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(settings)) delete settings[key];
    settings.ai_provider = "openai";
    settings.ai_enabled = "true";
    useAccountStore.setState({ accounts: [] });
  });

  it("switches provider, persists it and drops the cached clients", async () => {
    const { container } = render(<IntelligenceTab />);
    const provider = container.querySelector("select");

    await waitFor(() => expect(provider).toHaveValue("openai"));
    fireEvent.change(provider!, { target: { value: "gemini" } });

    await waitFor(() => expect(setSetting).toHaveBeenCalledWith("ai_provider", "gemini"));
    expect(clearProviderClients).toHaveBeenCalled();
  });

  it("turns the master AI toggle off", async () => {
    render(<IntelligenceTab />);

    const master = screen.getByRole("switch", { name: "Enable AI features" });
    await waitFor(() => expect(master).toHaveAttribute("aria-checked", "true"));
    fireEvent.click(master);

    await waitFor(() => expect(setSetting).toHaveBeenCalledWith("ai_enabled", "false"));
  });

  it("auto-archives a category", async () => {
    render(<IntelligenceTab />);

    fireEvent.click(screen.getByRole("switch", { name: "Auto-archive Promotions" }));

    await waitFor(() =>
      expect(setSetting).toHaveBeenCalledWith("auto_archive_categories", "Promotions"),
    );
  });
});
