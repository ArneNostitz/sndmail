import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const settings: Record<string, string> = {};
vi.mock("@/services/db/settings", () => ({
  getSetting: vi.fn(async (key: string) => settings[key] ?? null),
  setSetting: vi.fn(async (key: string, value: string) => {
    settings[key] = value;
  }),
}));
vi.mock("@/services/notifications/notificationManager", () => ({
  getNotificationBackend: vi.fn(() => "plugin"),
  getNativeNotificationFailure: vi.fn(() => null),
  applyNotificationsEnabled: vi.fn(async () => {}),
  sendTestNotification: vi.fn(async () => "plugin"),
}));
vi.mock("@tauri-apps/plugin-os", () => ({ platform: vi.fn(() => "macos") }));

import { useAccountStore } from "@/stores/accountStore";
import { setSetting } from "@/services/db/settings";
import { applyNotificationsEnabled } from "@/services/notifications/notificationManager";
import { NotificationsTab } from "./NotificationsTab";

const account = {
  id: "gmail-1",
  email: "me@example.com",
  displayName: "Me",
  avatarUrl: null,
  isActive: true,
};

describe("NotificationsTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(settings)) delete settings[key];
    // Sound on, but notifications currently switched off
    settings.notifications_enabled = "false";
    settings.smart_notifications = "true";
    settings.otp_detection = "true";
    settings.notify_categories = "Primary";
    useAccountStore.setState({ accounts: [{ ...account, provider: "gmail_api" }] });
  });

  it("turns notifications on and applies it straight away", async () => {
    render(<NotificationsTab />);

    const toggle = screen.getByRole("switch", { name: "Enable notifications" });
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));

    fireEvent.click(toggle);

    await waitFor(() => expect(setSetting).toHaveBeenCalledWith("notifications_enabled", "true"));
    expect(applyNotificationsEnabled).toHaveBeenCalledWith(true);
  });

  it("records the mailboxes that may notify", async () => {
    render(<NotificationsTab />);

    fireEvent.click(screen.getByRole("button", { name: "me@example.com" }));

    await waitFor(() => expect(setSetting).toHaveBeenCalledWith("notify_accounts", "gmail-1"));
  });

  it("drops a category that is switched off", async () => {
    render(<NotificationsTab />);

    fireEvent.click(screen.getByRole("button", { name: "Primary" }));

    await waitFor(() => expect(setSetting).toHaveBeenCalledWith("notify_categories", ""));
  });
});
