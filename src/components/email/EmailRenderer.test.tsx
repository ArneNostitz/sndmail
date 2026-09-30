import { render, waitFor, screen } from "@testing-library/react";
import { act } from "react";
import { EmailRenderer } from "./EmailRenderer";
import type { DbAttachment } from "@/services/db/attachments";
import type { MessageScanResult } from "@/utils/phishingDetector";
import { useComposerStore } from "@/stores/composerStore";
import { dispatchEmailNavigation } from "@/services/links/emailNavigation";

// Mock dependencies
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/utils/sanitize", () => ({
  sanitizeHtml: (html: string) => html,
  escapeHtml: (text: string) => text,
}));

vi.mock("@/services/db/imageAllowlist", () => ({
  addToAllowlist: vi.fn(),
}));

vi.mock("@/stores/uiStore", () => ({
  useUIStore: (selector: (s: { theme: string }) => string) =>
    selector({ theme: "light" }),
}));

const mockFetchAttachment = vi.fn();

vi.mock("@/services/email/providerFactory", () => ({
  getEmailProvider: vi.fn().mockResolvedValue({
    fetchAttachment: (...args: unknown[]) => mockFetchAttachment(...args),
  }),
}));

// Mock ResizeObserver for jsdom
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

function makeAttachment(overrides: Partial<DbAttachment> = {}): DbAttachment {
  return {
    id: "att-1",
    message_id: "msg-1",
    account_id: "acc-1",
    filename: "icon.png",
    mime_type: "image/png",
    size: 1024,
    gmail_attachment_id: "gmail-att-1",
    content_id: "icon@example.com",
    is_inline: 1,
    local_path: null,
    ...overrides,
  };
}


function makeScanResult(
  url: string,
  riskScore: number,
  overrides: Partial<MessageScanResult> = {},
): MessageScanResult {
  return {
    messageId: "msg-1",
    links: [
      {
        url,
        displayText: "Click here",
        riskScore,
        riskLevel: riskScore >= 60 ? "high" : riskScore >= 40 ? "medium" : riskScore >= 20 ? "low" : "safe",
        triggeredRules: riskScore
          ? [{ ruleId: "test-rule", name: "Test Rule", score: riskScore, detail: "why it is suspicious" }]
          : [],
      },
    ],
    maxRiskScore: riskScore,
    suspiciousLinkCount: riskScore >= 20 ? 1 : 0,
    showBanner: riskScore >= 40,
    scannedAt: Date.now(),
    ...overrides,
  };
}

/** Click the first anchor inside the rendered iframe document. */
function clickIframeLink(container: HTMLElement): void {
  const iframe = container.querySelector("iframe") as HTMLIFrameElement;
  const doc = iframe.contentDocument!;
  const anchor = doc.querySelector("a")!;
  act(() => {
    dispatchEmailNavigation(anchor.href);
  });
}

function clickIframeAction(container: HTMLElement, kind: string): void {
  const iframe = container.querySelector("iframe") as HTMLIFrameElement;
  const doc = iframe.contentDocument!;
  const anchor = doc.querySelector(`a[data-sndmail-kind="${kind}"]`)!;
  act(() => {
    dispatchEmailNavigation(anchor.href);
  });
}

describe("EmailRenderer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useComposerStore.setState({ isOpen: false, to: [], cc: [], bcc: [], subject: "", bodyHtml: "" });
  });

  it("renders plain text when no html provided", () => {
    const { container } = render(
      <EmailRenderer html={null} text="Hello world" />,
    );
    expect(container.querySelector("iframe")).toBeTruthy();
  });

  it("highlights search matches inside sanitized email content", () => {
    const { container } = render(
      <EmailRenderer
        html="<p>The Festival details are here</p>"
        text={null}
        highlightTerms={["festival"]}
      />,
    );
    const iframe = container.querySelector("iframe")!;
    const match = iframe.contentDocument!.querySelector(
      'mark[data-sndmail-search-match="true"]',
    );
    expect(match?.textContent).toBe("Festival");
  });

  it("renders html content in iframe", () => {
    const { container } = render(
      <EmailRenderer html="<p>Hello</p>" text={null} />,
    );
    expect(container.querySelector("iframe")).toBeTruthy();
  });

  it("opens the app context menu request for selected email text", () => {
    const onSelectionContextMenu = vi.fn();
    const { container } = render(
      <EmailRenderer
        html="<p>Follow up with the venue</p>"
        text={null}
        onSelectionContextMenu={onSelectionContextMenu}
      />,
    );
    const iframe = container.querySelector("iframe")!;
    const doc = iframe.contentDocument!;
    const text = doc.querySelector("p")!.firstChild!;
    const range = doc.createRange();
    range.selectNodeContents(text);
    const selection = doc.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 24,
      clientY: 32,
    });
    doc.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(onSelectionContextMenu).toHaveBeenCalledWith({
      position: { x: 24, y: 32 },
      text: "Follow up with the venue",
      contextMenu: true,
    });
  });

  it("offers task actions as soon as email text is selected", () => {
    const onSelectionContextMenu = vi.fn();
    const { container } = render(
      <EmailRenderer
        html="<p>Send the signed contract today</p>"
        text={null}
        onSelectionContextMenu={onSelectionContextMenu}
      />,
    );
    const iframe = container.querySelector("iframe")!;
    const doc = iframe.contentDocument!;
    const range = doc.createRange();
    range.selectNodeContents(doc.querySelector("p")!.firstChild!);
    const selection = doc.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    doc.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 18, clientY: 26 }));

    expect(onSelectionContextMenu).toHaveBeenCalledWith({
      position: { x: 18, y: 26 },
      text: "Send the signed contract today",
    });
  });

  it("offers task actions when the iframe reports a selection change", () => {
    const onSelectionContextMenu = vi.fn();
    const { container } = render(
      <EmailRenderer
        html="<p>Confirm the appointment for Tuesday</p>"
        text={null}
        onSelectionContextMenu={onSelectionContextMenu}
      />,
    );
    const iframe = container.querySelector("iframe")!;
    const doc = iframe.contentDocument!;
    const range = doc.createRange();
    range.selectNodeContents(doc.querySelector("p")!.firstChild!);
    const selection = doc.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    onSelectionContextMenu.mockClear();

    doc.dispatchEvent(new Event("selectionchange"));

    expect(onSelectionContextMenu).toHaveBeenCalledWith({
      position: { x: 12, y: 12 },
      text: "Confirm the appointment for Tuesday",
    });
  });

  it("blocks email scripts through CSP before message markup and preserves link destinations", () => {
    const { container } = render(<EmailRenderer html='<a target="_blank" href="https://example.com/path">Open</a>' text={null} />);
    const iframe = container.querySelector("iframe")!;
    expect(iframe.getAttribute("sandbox")).toBe("allow-same-origin allow-scripts allow-top-navigation-by-user-activation");
    const policy = iframe.contentDocument!.head.firstElementChild!;
    expect(policy.tagName).toBe("META");
    expect(policy.getAttribute("content")).toContain("script-src 'none'");
    expect(iframe.contentDocument!.querySelector("script")).toBeNull();
    expect(iframe.contentDocument!.querySelector("a")!.getAttribute("href")).toBe("https://example.com/path");
  });

  it("forwards an unselected body context menu to the message with parent coordinates", () => {
    const onContextMenu = vi.fn((event: React.MouseEvent) => event.preventDefault());
    const { container } = render(<div onContextMenu={onContextMenu}>
      <EmailRenderer html="<p>Message body</p>" text={null} />
    </div>);
    const iframe = container.querySelector("iframe")!;
    vi.spyOn(iframe, "getBoundingClientRect").mockReturnValue({ left: 200, top: 100 } as DOMRect);
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 30 });
    iframe.contentDocument!.body.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(onContextMenu).toHaveBeenCalledWith(expect.objectContaining({ clientX: 220, clientY: 130 }));
  });

  it("positions the menu beside the full address inside the iframe", () => {
    const { container } = render(<EmailRenderer html="1455 3rd Street<br>San Francisco, CA 94158" text={null} />);
    const iframe = container.querySelector("iframe")!;
    const anchor = iframe.contentDocument!.querySelector("a")!;
    vi.spyOn(iframe, "getBoundingClientRect").mockReturnValue({ left: 400, top: 100 } as DOMRect);
    vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue({ left: 20, bottom: 80 } as DOMRect);
    clickIframeAction(container, "address");
    const menu = screen.getByRole("menu", { name: "Actions for 1455 3rd Street, San Francisco, CA 94158" });
    expect(menu).toHaveStyle({ left: "420px", top: "188px" });
  });

  it("resolves cid: references by fetching inline attachment data", async () => {
    const base64Data = btoa("fake-image-data");
    mockFetchAttachment.mockResolvedValue({ data: base64Data, size: 100 });

    const inlineAttachments = [makeAttachment()];

    const { container } = render(
      <EmailRenderer
        html='<img src="cid:icon@example.com" />'
        text={null}
        accountId="acc-1"
        messageId="msg-1"
        inlineAttachments={inlineAttachments}
      />,
    );

    await waitFor(() => {
      expect(mockFetchAttachment).toHaveBeenCalledWith("msg-1", "gmail-att-1");
    });

    expect(container.querySelector("iframe")).toBeTruthy();
  });

  it("skips cid resolution when no inline attachments", () => {
    render(
      <EmailRenderer
        html='<img src="cid:missing@example.com" />'
        text={null}
        accountId="acc-1"
        messageId="msg-1"
        inlineAttachments={[]}
      />,
    );

    expect(mockFetchAttachment).not.toHaveBeenCalled();
  });

  it("skips cid resolution when accountId or messageId missing", () => {
    const inlineAttachments = [makeAttachment()];

    render(
      <EmailRenderer
        html='<img src="cid:icon@example.com" />'
        text={null}
        inlineAttachments={inlineAttachments}
      />,
    );

    expect(mockFetchAttachment).not.toHaveBeenCalled();
  });

  it("handles fetch failure gracefully", async () => {
    mockFetchAttachment.mockRejectedValue(new Error("Network error"));

    const inlineAttachments = [makeAttachment()];

    const { container } = render(
      <EmailRenderer
        html='<img src="cid:icon@example.com" />'
        text={null}
        accountId="acc-1"
        messageId="msg-1"
        inlineAttachments={inlineAttachments}
      />,
    );

    await waitFor(() => {
      expect(mockFetchAttachment).toHaveBeenCalled();
    });

    expect(container.querySelector("iframe")).toBeTruthy();
  });

  it("offers compose, copy, and contact actions for an email address", () => {
    const { container } = render(
      <EmailRenderer html={null} text="Write to jane@example.com" />,
    );

    clickIframeLink(container);

    expect(screen.getByRole("menu", { name: "Actions for jane@example.com" })).toBeTruthy();
    expect(screen.getByText("Write email")).toBeTruthy();
    expect(screen.getByText("Copy email address")).toBeTruthy();
    expect(screen.getByText("Add to contacts")).toBeTruthy();

    act(() => {
      screen.getByText("Write email").click();
    });
    expect(useComposerStore.getState()).toMatchObject({ isOpen: true, to: ["jane@example.com"] });
  });

  it("offers call and copy actions for a detected phone number", () => {
    const { container } = render(
      <EmailRenderer html={null} text="Call +43 660 123 4567" />,
    );

    clickIframeAction(container, "phone");

    expect(screen.getByText("Call")).toBeTruthy();
    expect(screen.getByText("Copy phone number")).toBeTruthy();
  });

  it("opens a detected phone number in the calling app", async () => {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    const { container } = render(
      <EmailRenderer html={null} text="Call +43 660 123 4567" />,
    );
    clickIframeAction(container, "phone");

    act(() => {
      screen.getByText("Call").click();
    });

    expect(openUrl).toHaveBeenCalledWith("tel:+436601234567");
  });

  it("offers calendar creation for a detected date", () => {
    const { container } = render(
      <EmailRenderer html="<p>Meet on 12.09.2026 at 14:30</p>" text={null} />,
    );

    clickIframeAction(container, "date");

    expect(screen.getByText("Create calendar event")).toBeTruthy();
    expect(screen.getByText("Copy date")).toBeTruthy();
  });

  it("resolves multiple cid references", async () => {
    mockFetchAttachment
      .mockResolvedValueOnce({ data: btoa("img1"), size: 50 })
      .mockResolvedValueOnce({ data: btoa("img2"), size: 60 });

    const inlineAttachments = [
      makeAttachment({ id: "att-1", content_id: "img1@ex.com", gmail_attachment_id: "g1" }),
      makeAttachment({ id: "att-2", content_id: "img2@ex.com", gmail_attachment_id: "g2", mime_type: "image/jpeg" }),
    ];

    render(
      <EmailRenderer
        html='<img src="cid:img1@ex.com" /><img src="cid:img2@ex.com" />'
        text={null}
        accountId="acc-1"
        messageId="msg-1"
        inlineAttachments={inlineAttachments}
      />,
    );

    await waitFor(() => {
      expect(mockFetchAttachment).toHaveBeenCalledTimes(2);
      expect(mockFetchAttachment).toHaveBeenCalledWith("msg-1", "g1");
      expect(mockFetchAttachment).toHaveBeenCalledWith("msg-1", "g2");
    });
  });

  it("ignores attachments without content_id or gmail_attachment_id", () => {
    const inlineAttachments = [
      makeAttachment({ content_id: null }),
      makeAttachment({ id: "att-2", gmail_attachment_id: null }),
    ];

    render(
      <EmailRenderer
        html='<img src="cid:icon@example.com" />'
        text={null}
        accountId="acc-1"
        messageId="msg-1"
        inlineAttachments={inlineAttachments}
      />,
    );

    expect(mockFetchAttachment).not.toHaveBeenCalled();
  });

  describe("phishing link confirmation", () => {
    const html = '<a href="https://paypal-security.com/verify">Click here</a>';

    it("opens a safe link directly without a confirmation dialog", async () => {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      const { container } = render(
        <EmailRenderer html={html} text={null} scanResult={makeScanResult("https://paypal-security.com/verify", 0)} />,
      );

      clickIframeLink(container);

      expect(openUrl).toHaveBeenCalledWith("https://paypal-security.com/verify");
      expect(screen.queryByText(/Suspicious Link|High Risk Link/)).toBeNull();
    });

    it("shows the confirmation dialog instead of opening a flagged link", async () => {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      const { container } = render(
        <EmailRenderer html={html} text={null} scanResult={makeScanResult("https://paypal-security.com/verify", 50)} />,
      );

      clickIframeLink(container);

      expect(openUrl).not.toHaveBeenCalled();
      expect(screen.getByText("Suspicious Link")).toBeTruthy();
      // The real destination is shown to the user before anything opens
      expect(screen.getByText("https://paypal-security.com/verify")).toBeTruthy();
      expect(screen.getByText("Test Rule")).toBeTruthy();
    });

    it("labels a high-risk link differently", async () => {
      const { container } = render(
        <EmailRenderer html={html} text={null} scanResult={makeScanResult("https://paypal-security.com/verify", 70)} />,
      );

      clickIframeLink(container);

      expect(screen.getByText("High Risk Link")).toBeTruthy();
    });

    it("opens the link after the user confirms", async () => {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      const { container } = render(
        <EmailRenderer html={html} text={null} scanResult={makeScanResult("https://paypal-security.com/verify", 50)} />,
      );

      clickIframeLink(container);
      act(() => {
        screen.getByText("Open Anyway").click();
      });

      await waitFor(() => {
        expect(openUrl).toHaveBeenCalledWith("https://paypal-security.com/verify");
      });
    });

    it("does not open the link when the user goes back", async () => {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      const { container } = render(
        <EmailRenderer html={html} text={null} scanResult={makeScanResult("https://paypal-security.com/verify", 50)} />,
      );

      clickIframeLink(container);
      act(() => {
        screen.getByText("Go Back").click();
      });

      expect(openUrl).not.toHaveBeenCalled();
      expect(screen.queryByText("Suspicious Link")).toBeNull();
    });

    it("matches a flagged link even when the href is normalised by the browser", async () => {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      // Scan recorded the raw href without a trailing slash; anchor.href adds one
      const { container } = render(
        <EmailRenderer
          html='<a href="https://evil.example">Click here</a>'
          text={null}
          scanResult={makeScanResult("https://evil.example", 50)}
        />,
      );

      clickIframeLink(container);

      expect(openUrl).not.toHaveBeenCalled();
      expect(screen.getByText("Suspicious Link")).toBeTruthy();
    });

    it("opens links normally when scanning is disabled (no scan result)", async () => {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      const { container } = render(<EmailRenderer html={html} text={null} scanResult={null} />);

      clickIframeLink(container);

      expect(openUrl).toHaveBeenCalledWith("https://paypal-security.com/verify");
    });
  });
});
