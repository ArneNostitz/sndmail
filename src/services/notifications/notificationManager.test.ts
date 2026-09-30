import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NativeNotificationResponse } from "./nativeNotifications";

const settings = new Map<string, string>();

let nativeAvailable = true;
let nativeGranted = true;
let actionHandler: ((r: NativeNotificationResponse) => void | Promise<void>) | null = null;

const mockRegisterCategories = vi.fn(() => Promise.resolve());
const mockShowNative = vi.fn(() => Promise.resolve("sndmail-1-0"));
const mockSendPlugin = vi.fn();
const mockPluginGranted = vi.fn(() => Promise.resolve(true));
const mockShowWindow = vi.fn(() => Promise.resolve());
const mockFocusWindow = vi.fn(() => Promise.resolve());
const mockOpenComposer = vi.fn();
const mockNavigate = vi.fn();
const mockArchive = vi.fn(() => Promise.resolve({ success: true }));
const mockWriteText = vi.fn(() => Promise.resolve());
const mockReportError = vi.fn();

vi.mock("./nativeNotifications", () => ({
  nativeNotificationsAvailable: () => Promise.resolve(nativeAvailable),
  requestNativePermission: () => Promise.resolve(nativeGranted),
  registerNativeCategories: (...args: unknown[]) => mockRegisterCategories(...args),
  showNativeNotification: (...args: unknown[]) => mockShowNative(...args),
  listenForNativeActions: (handler: typeof actionHandler) => {
    actionHandler = handler;
    return Promise.resolve(() => { actionHandler = null; });
  },
}));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: () => mockPluginGranted(),
  requestPermission: () => Promise.resolve("granted"),
  sendNotification: (...args: unknown[]) => mockSendPlugin(...args),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: {
    getByLabel: () => Promise.resolve({ show: mockShowWindow, setFocus: mockFocusWindow }),
  },
}));
vi.mock("../../stores/composerStore", () => ({
  useComposerStore: { getState: () => ({ openComposer: mockOpenComposer }) },
}));
vi.mock("../../router/navigate", () => ({
  navigateToLabel: (...args: unknown[]) => mockNavigate(...args),
}));
vi.mock("../emailActions", () => ({
  archiveThread: (...args: unknown[]) => mockArchive(...args),
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: (...args: unknown[]) => mockWriteText(...args),
}));
vi.mock("../db/settings", () => ({
  getSetting: (key: string) => Promise.resolve(settings.get(key) ?? null),
}));
vi.mock("@/stores/toastStore", () => ({
  reportError: (...args: unknown[]) => mockReportError(...args),
  notify: vi.fn(),
}));

import {
  initNotifications,
  getNotificationBackend,
  applyNotificationsEnabled,
  queueNewEmailNotification,
  notifyOneTimeCode,
  notifyFollowUpDue,
  sendTestNotification,
  resetNotificationsForTests,
  NOTIFICATION_CATEGORIES,
} from "./notificationManager";

async function press(actionId: string, context: unknown = {}): Promise<void> {
  if (!actionHandler) throw new Error("not listening");
  await actionHandler({ actionId, notificationId: "sndmail-1-0", context });
}

/** Wait for the promise chain inside `show()` to settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  settings.clear();
  nativeAvailable = true;
  nativeGranted = true;
  actionHandler = null;
  resetNotificationsForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("choosing a backend", () => {
  it("uses the native path when Rust offers it, and registers the button sets", async () => {
    await initNotifications();
    expect(getNotificationBackend()).toBe("native");
    expect(mockRegisterCategories).toHaveBeenCalledWith(NOTIFICATION_CATEGORIES);
    expect(actionHandler).not.toBeNull();
    expect(mockPluginGranted).not.toHaveBeenCalled();
  });

  it("falls back to the plugin where there is no native path", async () => {
    nativeAvailable = false;
    await initNotifications();
    expect(getNotificationBackend()).toBe("plugin");
    expect(mockRegisterCategories).not.toHaveBeenCalled();
  });

  it("stays quiet when macOS refuses permission — the plugin would be refused too", async () => {
    nativeGranted = false;
    await initNotifications();
    expect(getNotificationBackend()).toBe("off");
    notifyFollowUpDue("Waiting", "t1", "a1");
    await settle();
    expect(mockShowNative).not.toHaveBeenCalled();
    expect(mockSendPlugin).not.toHaveBeenCalled();
  });

  it("does not warn that mail alerts are broken when the worker owns them", async () => {
    mockRegisterCategories.mockRejectedValueOnce(new Error("Notifications are not allowed for this application"));
    await initNotifications({ quietNativeFailure: true });
    expect(mockReportError).not.toHaveBeenCalled();
    expect(getNotificationBackend()).toBe("plugin");
  });

  it("honours the setting without a restart", async () => {
    await initNotifications();
    await applyNotificationsEnabled(false);
    expect(getNotificationBackend()).toBe("off");
    notifyFollowUpDue("Waiting");
    await settle();
    expect(mockShowNative).not.toHaveBeenCalled();

    await applyNotificationsEnabled(true);
    expect(getNotificationBackend()).toBe("native");
  });

  it("is off when the setting says so", async () => {
    settings.set("notifications_enabled", "false");
    await initNotifications();
    expect(getNotificationBackend()).toBe("off");
  });
});

describe("what a press does", () => {
  beforeEach(async () => {
    await initNotifications();
  });

  it("replies in the thread the notification was about, not the latest one", async () => {
    await press("reply", {
      threadId: "t-old",
      accountId: "acc-2",
      fromAddress: "ann@example.com",
      subject: "Lunch",
    });
    expect(mockShowWindow).toHaveBeenCalled();
    expect(mockFocusWindow).toHaveBeenCalled();
    expect(mockOpenComposer).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "reply",
        to: ["ann@example.com"],
        subject: "Re: Lunch",
        threadId: "t-old",
        accountId: "acc-2",
      }),
    );
  });

  it("archives through emailActions with the notification's own account", async () => {
    await press("archive", { threadId: "t1", accountId: "acc-1" });
    expect(mockArchive).toHaveBeenCalledWith("acc-1", "t1", []);
    expect(mockShowWindow).not.toHaveBeenCalled();
  });

  it("copies the code and confirms, since the pressed notification is gone", async () => {
    await press("copy-code", { code: "493028" });
    expect(mockWriteText).toHaveBeenCalledWith("493028");
    await settle();
    expect(mockShowNative).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Copied 493028" }),
    );
  });

  it("opens a sign-in link through the app, never straight to the browser", async () => {
    const seen = vi.fn();
    window.addEventListener("sndmail-open-signin-link", seen);
    await press("open-link", { linkUrl: "https://example.com/login?t=1", threadId: "t1" });
    window.removeEventListener("sndmail-open-signin-link", seen);
    expect(mockShowWindow).toHaveBeenCalled();
    expect(seen).toHaveBeenCalledTimes(1);
    const detail = (seen.mock.calls[0]![0] as CustomEvent).detail;
    expect(detail.url).toBe("https://example.com/login?t=1");
  });

  it("opens the thread on a click of the body", async () => {
    await press("default", { threadId: "t7" });
    expect(mockShowWindow).toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith("inbox", { threadId: "t7" });
  });

  it("does nothing on a dismiss", async () => {
    await press("dismiss", { threadId: "t7" });
    expect(mockShowWindow).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("falls back to opening the mail when a button's context is missing", async () => {
    await press("reply", { threadId: "t7" });
    expect(mockOpenComposer).not.toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith("inbox", { threadId: "t7" });
  });
});

describe("what gets sent", () => {
  it("sends each mail with Reply/Archive up to three, then a summary", async () => {
    vi.useFakeTimers();
    await initNotifications();

    queueNewEmailNotification("Ann", "One", "t1", "a1", "ann@example.com");
    queueNewEmailNotification("Bob", "Two", "t2", "a1", "bob@example.com");
    vi.advanceTimersByTime(2000);
    expect(mockShowNative).toHaveBeenCalledTimes(2);
    expect(mockShowNative).toHaveBeenCalledWith({
      title: "Ann",
      body: "One",
      categoryId: "email",
      context: { threadId: "t1", accountId: "a1", fromAddress: "ann@example.com", subject: "One" },
      group: "t1",
    });

    mockShowNative.mockClear();
    for (let i = 0; i < 5; i++) {
      queueNewEmailNotification(`Sender ${i}`, `Mail ${i}`, `t${i}`, "a1");
    }
    vi.advanceTimersByTime(2000);
    expect(mockShowNative).toHaveBeenCalledTimes(1);
    expect(mockShowNative).toHaveBeenCalledWith(
      expect.objectContaining({ title: "sndmail", body: "5 new emails" }),
    );
  });

  it("gives a code-and-link mail both buttons and a plain body", async () => {
    await initNotifications();
    notifyOneTimeCode({
      code: "493028",
      linkUrl: "https://example.com/l",
      sender: "Example",
      copied: true,
      threadId: "t1",
      accountId: "a1",
    });
    await settle();
    expect(mockShowNative).toHaveBeenCalledWith({
      title: "Code copied: 493028",
      body: "From Example",
      categoryId: "otp-both",
      context: { threadId: "t1", accountId: "a1", code: "493028", linkUrl: "https://example.com/l" },
      group: "t1",
    });
  });

  it("without buttons, says where the link is waiting instead", async () => {
    nativeAvailable = false;
    await initNotifications();
    notifyOneTimeCode({ code: "493028", linkUrl: "https://example.com/l", sender: "Example", copied: false });
    await settle();
    expect(mockShowNative).not.toHaveBeenCalled();
    expect(mockSendPlugin).toHaveBeenCalledWith({
      title: "Code: 493028",
      body: "From Example — Sign-in link waiting in sndmail",
    });
  });

  it("shows a plain notification when the native one fails", async () => {
    await initNotifications();
    mockShowNative.mockRejectedValueOnce(new Error("centre down"));
    notifyFollowUpDue("Waiting", "t1", "a1");
    await settle();
    expect(mockSendPlugin).toHaveBeenCalledWith({ title: "Follow up needed", body: "Waiting" });
  });

  it("sends a test notification whose Copy code button works", async () => {
    await initNotifications();
    expect(await sendTestNotification()).toBe("native");
    expect(mockShowNative).toHaveBeenCalledWith(
      expect.objectContaining({ categoryId: "otp-code", context: { code: "123456" } }),
    );
  });
});
