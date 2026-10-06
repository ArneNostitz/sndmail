import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { createRef } from "react";
import { MessageItem } from "./MessageItem";
import type { DbMessage } from "@/services/db/messages";
import { useAccountStore } from "@/stores/accountStore";

vi.mock("./EmailRenderer", () => ({
  EmailRenderer: ({ highlightTerms, html, text }: { highlightTerms?: readonly string[]; html: string | null; text: string | null }) => (
    <div data-testid="email-renderer" data-highlight-terms={highlightTerms?.join(",") ?? ""} data-html={html ?? ""} data-text={text ?? ""} />
  ),
}));

vi.mock("./InlineAttachmentPreview", () => ({
  InlineAttachmentPreview: () => null,
}));

vi.mock("./AttachmentList", () => ({
  AttachmentList: () => null,
  useAttachmentViewer: () => ({ fileAttachments: [], openAttachment: vi.fn(), viewer: null }),
  getAttachmentsForMessage: vi.fn().mockResolvedValue([]),
}));

vi.mock("./AuthBadge", () => ({
  AuthBadge: () => null,
}));

vi.mock("./AuthWarningBanner", () => ({
  AuthWarningBanner: () => null,
}));

function makeMessage(overrides: Partial<DbMessage> = {}): DbMessage {
  return {
    id: "m1",
    account_id: "a1",
    thread_id: "t1",
    from_address: "bob@example.com",
    from_name: "Bob",
    to_addresses: "alice@example.com",
    cc_addresses: null,
    bcc_addresses: null,
    reply_to: null,
    subject: "Test subject",
    snippet: "Test snippet",
    date: Date.now(),
    is_read: 0,
    is_starred: 0,
    body_html: "<p>Hello</p>",
    body_text: "Hello",
    body_cached: 1,
    raw_size: 100,
    internal_date: null,
    list_unsubscribe: null,
    list_unsubscribe_post: null,
    auth_results: null,
    message_id_header: null,
    references_header: null,
    in_reply_to_header: null,
    ...overrides,
  };
}

describe("MessageItem", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders sender name", () => {
    render(<MessageItem message={makeMessage()} isLast={true} blockImages={false} />);
    expect(screen.getByText("Bob")).toBeInTheDocument();
  });

  it("applies red background when isSpam is true", () => {
    const { container } = render(
      <MessageItem message={makeMessage()} isLast={true} blockImages={false} isSpam={true} />,
    );
    const wrapper = container.firstElementChild!;
    expect(wrapper.className).toContain("bg-red-500/8");
  });

  it("does not apply red background when isSpam is false", () => {
    const { container } = render(
      <MessageItem message={makeMessage()} isLast={true} blockImages={false} isSpam={false} />,
    );
    const wrapper = container.firstElementChild!;
    expect(wrapper.className).not.toContain("bg-red-500");
  });

  it("does not apply red background when isSpam is undefined", () => {
    const { container } = render(
      <MessageItem message={makeMessage()} isLast={true} blockImages={false} />,
    );
    const wrapper = container.firstElementChild!;
    expect(wrapper.className).not.toContain("bg-red-500");
  });

  it("applies focus ring when focused prop is true", () => {
    const { container } = render(
      <MessageItem message={makeMessage()} isLast={false} blockImages={false} focused={true} />,
    );
    const wrapper = container.firstElementChild!;
    expect(wrapper.className).toContain("ring-accent/50");
  });

  it("does not apply focus ring when focused is false", () => {
    const { container } = render(
      <MessageItem message={makeMessage()} isLast={false} blockImages={false} focused={false} />,
    );
    const wrapper = container.firstElementChild!;
    expect(wrapper.className).not.toContain("ring-accent/50");
  });

  it("auto-expands when focused becomes true", () => {
    // Render collapsed (isLast=false, not focused)
    const { container, rerender } = render(
      <MessageItem message={makeMessage()} isLast={false} blockImages={false} focused={false} />,
    );
    // Should be collapsed — no email renderer visible
    expect(container.querySelector("[data-testid='email-renderer']")).toBeNull();

    // Now set focused=true
    rerender(
      <MessageItem message={makeMessage()} isLast={false} blockImages={false} focused={true} />,
    );
    // Should now be expanded — email renderer visible
    expect(container.querySelector("[data-testid='email-renderer']")).toBeInTheDocument();
  });

  it("opens a matching older message and forwards its highlight terms", () => {
    render(
      <MessageItem
        message={makeMessage()}
        isLast={false}
        blockImages={false}
        isSearchMatch
        highlightTerms={["festival"]}
      />,
    );
    expect(screen.getByTestId("email-renderer")).toHaveAttribute(
      "data-highlight-terms",
      "festival",
    );
  });

  it("hides quoted HTML by default and lets the reader reveal the full message", () => {
    render(
      <MessageItem
        message={makeMessage({
          body_html: '<p>My reply</p><div class="gmail_signature">My signature</div><blockquote><p>Earlier message</p></blockquote>',
          body_text: "My reply\nEarlier message",
        })}
        isLast
        blockImages={false}
      />,
    );

    expect(screen.getByTestId("email-renderer")).toHaveAttribute("data-html", "<p>My reply</p>");
    expect(screen.getByTestId("email-renderer")).toHaveAttribute("data-text", "My reply\nEarlier message");
    fireEvent.click(screen.getByRole("button", { name: "View full message" }));
    expect(screen.getByTestId("email-renderer")).toHaveAttribute(
      "data-html",
      '<p>My reply</p><div class="gmail_signature">My signature</div><blockquote><p>Earlier message</p></blockquote>',
    );
    expect(screen.getByRole("button", { name: "Hide quoted text" })).toBeInTheDocument();
  });

  it("shows full content for search matches even when it contains a quote", () => {
    render(
      <MessageItem
        message={makeMessage({ body_html: "<p>Reply</p><blockquote>Search hit</blockquote>" })}
        isLast={false}
        blockImages={false}
        isSearchMatch
      />,
    );
    expect(screen.getByTestId("email-renderer")).toHaveAttribute(
      "data-html",
      "<p>Reply</p><blockquote>Search hit</blockquote>",
    );
  });

  it("forwards ref to outer div", () => {
    const ref = createRef<HTMLDivElement>();
    render(
      <MessageItem ref={ref} message={makeMessage()} isLast={true} blockImages={false} />,
    );
    expect(ref.current).toBeInstanceOf(HTMLDivElement);
  });
});

describe("MessageItem - \"Opened\" marker", () => {
  const sentFromAlias = makeMessage({
    from_address: "alias@example.com",
    read_receipt_count: 2,
    read_receipt_last_at: Date.now(),
  });

  beforeEach(() => {
    useAccountStore.setState({
      accounts: [{ id: "a1", email: "me@example.com" }] as never,
    });
  });

  it("counts a message sent from a send-as alias as the user's own", () => {
    render(
      <MessageItem
        message={sentFromAlias}
        isLast={false}
        ownAddresses={new Set(["me@example.com", "alias@example.com"])}
      />,
    );
    expect(screen.getByText("Opened 2×")).toBeInTheDocument();
  });

  it("stays silent for a message the user did not send", () => {
    render(
      <MessageItem
        message={sentFromAlias}
        isLast={false}
        ownAddresses={new Set(["me@example.com"])}
      />,
    );
    expect(screen.queryByText(/Opened/)).not.toBeInTheDocument();
  });

  it("falls back to the account address when no own addresses are supplied", () => {
    render(
      <MessageItem
        message={makeMessage({ from_address: "me@example.com", read_receipt_count: 1 })}
        isLast={false}
      />,
    );
    expect(screen.getByText("Opened")).toBeInTheDocument();
  });
});

describe("MessageItem - the whole header toggles", () => {
  it("expands when the header is clicked anywhere, not just the button", () => {
    render(<MessageItem message={makeMessage()} isLast={false} />);
    const header = screen.getByRole("button", { expanded: false });
    fireEvent.click(header);
    expect(screen.getByRole("button", { expanded: true })).toBeInTheDocument();
  });

  it("responds to Enter and Space, so it is reachable by keyboard", () => {
    render(<MessageItem message={makeMessage()} isLast={false} />);
    const header = screen.getByRole("button", { expanded: false });
    fireEvent.keyDown(header, { key: "Enter" });
    expect(screen.getByRole("button", { expanded: true })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("button", { expanded: true }), { key: " " });
    expect(screen.getByRole("button", { expanded: false })).toBeInTheDocument();
  });
});
