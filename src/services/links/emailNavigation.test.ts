import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/stores/toastStore", () => ({ reportError: vi.fn() }));

import { openUrl } from "@tauri-apps/plugin-opener";
import { reportError } from "@/stores/toastStore";
import {
  dispatchEmailNavigation,
  openExternalLink,
  registerEmailNavigationHandler,
  startEmailNavigationListener,
  type EmailNavigationHandler,
} from "./emailNavigation";

function handler(overrides: Partial<EmailNavigationHandler> = {}): EmailNavigationHandler {
  return {
    run: vi.fn(() => true),
    resolveFallback: vi.fn(() => null),
    showFallback: vi.fn(),
    analyze: vi.fn(() => null),
    confirm: vi.fn(),
    ...overrides,
  };
}

describe("email navigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes a private action URL to exactly its renderer", () => {
    const first = handler();
    const second = handler();
    const offFirst = registerEmailNavigationHandler("first", first);
    const offSecond = registerEmailNavigationHandler("second", second);
    dispatchEmailNavigation("tauri://localhost/__sndmail_email_action__/second/4");
    expect(first.run).not.toHaveBeenCalled();
    expect(second.run).toHaveBeenCalledWith("4");
    offFirst();
    offSecond();
  });

  it("still routes legacy Velo action URLs", () => {
    const target = handler();
    const off = registerEmailNavigationHandler("legacy", target);
    dispatchEmailNavigation("tauri://localhost/__velo_email_action__/legacy/4");
    expect(target.run).toHaveBeenCalledWith("4");
    off();
  });

  it("opens a safe external URL and confirms a flagged one", async () => {
    const flagged = handler({
      analyze: vi.fn((url) => ({
        url,
        displayText: url,
        riskScore: 50,
        riskLevel: "medium",
        triggeredRules: [],
      })),
    });
    const off = registerEmailNavigationHandler("flagged", flagged);
    await openExternalLink("https://danger.example/");
    expect(flagged.confirm).toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
    off();

    await openExternalLink("https://safe.example/");
    expect(openUrl).toHaveBeenCalledWith("https://safe.example/");
  });

  it("shows typed fallback actions instead of handing them to the OS", async () => {
    const mail = { kind: "email", value: "a@example.com", label: "A", href: "mailto:a@example.com" } as const;
    const owner = handler({ resolveFallback: vi.fn(() => mail) });
    const off = registerEmailNavigationHandler("mail", owner);
    await openExternalLink(mail.href);
    expect(owner.showFallback).toHaveBeenCalledWith(mail);
    expect(openUrl).not.toHaveBeenCalled();
    off();
  });

  it("listens for native navigation events", async () => {
    const target = handler();
    const off = registerEmailNavigationHandler("target", target);
    const unlisten = await startEmailNavigationListener();
    window.dispatchEvent(new CustomEvent("sndmail-email-navigation", {
      detail: "tauri://localhost/__sndmail_email_action__/target/9",
    }));
    expect(target.run).toHaveBeenCalledWith("9");
    unlisten();
    off();
  });

  it("fails loudly when an action is stale", () => {
    dispatchEmailNavigation("tauri://localhost/__velo_email_action__/missing/1");
    expect(reportError).toHaveBeenCalledWith(
      "Could not open email action",
      "The message action is no longer available.",
    );
  });

  it("does not mistake an external website path for a private action", () => {
    const url = "https://example.com/__velo_email_action__/missing/1";
    dispatchEmailNavigation(url);
    expect(openUrl).toHaveBeenCalledWith(url);
    expect(reportError).not.toHaveBeenCalled();
  });
});
