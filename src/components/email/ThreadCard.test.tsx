import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ThreadCard } from "./ThreadCard";
import type { Thread } from "@/stores/threadStore";

vi.mock("@dnd-kit/core", () => ({
  useDraggable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    isDragging: false,
  }),
}));

vi.mock("@/stores/threadStore", () => ({
  useThreadStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) =>
      selector({
        selectedThreadIds: new Set(),
        removingThreadIds: new Set(),
        toggleThreadSelection: vi.fn(),
        selectThreadRange: vi.fn(),
      }),
    { getState: () => ({ selectedThreadIds: new Set() }) },
  ),
}));

vi.mock("@/stores/uiStore", () => ({
  useUIStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ emailDensity: "default" }),
}));

vi.mock("@/stores/accountStore", () => ({
  useAccountStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      accounts: [{
        id: "a1",
        email: "inbox@example.com",
        displayName: "Work",
        avatarUrl: null,
        color: "emerald",
      }],
    }),
}));

vi.mock("@/hooks/useRouteNavigation", () => ({
  useActiveLabel: () => "inbox",
}));

vi.mock("@/stores/labelStore", () => ({
  useLabelStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ labels: [{ id: "Label_1", name: "Receipts" }] }),
}));

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "t1",
    accountId: "a1",
    subject: "Test subject",
    snippet: "Test snippet",
    lastMessageAt: Date.now(),
    messageCount: 1,
    isRead: false,
    isStarred: false,
    isPinned: false,
    isMuted: false,
    hasAttachments: false,
    labelIds: ["INBOX"],
    fromName: "Alice",
    fromAddress: "alice@example.com",
    ...overrides,
  };
}

describe("ThreadCard", () => {
  const onClick = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders sender name and subject", () => {
    render(<ThreadCard thread={makeThread()} isSelected={false} onClick={onClick} />);
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("Test subject")).toBeInTheDocument();
  });

  it("shows the account that received the message beside its timestamp", () => {
    render(<ThreadCard thread={makeThread()} isSelected={false} onClick={onClick} />);
    expect(screen.getByLabelText("Received by Work")).toBeInTheDocument();
  });

  it("replaces the latest snippet with the matching line and highlights it", () => {
    render(
      <ThreadCard
        thread={makeThread({ snippet: "Unrelated latest text" })}
        isSelected={false}
        onClick={onClick}
        searchExcerpt="The Festival details are inside this message"
        highlightTerms={["festival"]}
      />,
    );
    expect(screen.queryByText("Unrelated latest text")).toBeNull();
    const match = screen.getByText("Festival");
    expect(match.tagName).toBe("MARK");
    expect(match.parentElement).toHaveTextContent(
      "The Festival details are inside this message",
    );
  });

  it("applies red background for spam threads", () => {
    const { container } = render(
      <ThreadCard
        thread={makeThread({ labelIds: ["SPAM"] })}
        isSelected={false}
        onClick={onClick}
      />,
    );
    const button = container.querySelector("button")!;
    expect(button.className).toContain("bg-red-500/8");
  });

  it("does not apply red background for non-spam threads", () => {
    const { container } = render(
      <ThreadCard
        thread={makeThread({ labelIds: ["INBOX"] })}
        isSelected={false}
        onClick={onClick}
      />,
    );
    const button = container.querySelector("button")!;
    expect(button.className).not.toContain("bg-red-500");
  });

  it("applies red background for spam even when thread has other labels", () => {
    const { container } = render(
      <ThreadCard
        thread={makeThread({ labelIds: ["INBOX", "SPAM", "IMPORTANT"] })}
        isSelected={false}
        onClick={onClick}
      />,
    );
    const button = container.querySelector("button")!;
    expect(button.className).toContain("bg-red-500/8");
  });
});

describe("ThreadCard - who spoke last", () => {
  const onClick = vi.fn();

  it("marks threads whose newest message the user sent", () => {
    render(
      <ThreadCard thread={makeThread({ lastFromMe: true })} isSelected={false} onClick={onClick} />,
    );
    expect(screen.getByText("me:")).toBeInTheDocument();
  });

  it("shows no marker when the other side wrote last", () => {
    render(
      <ThreadCard thread={makeThread({ lastFromMe: false })} isSelected={false} onClick={onClick} />,
    );
    expect(screen.queryByText("me:")).not.toBeInTheDocument();
  });

  describe("folder tag", () => {
    it("is absent unless asked for", () => {
      render(<ThreadCard thread={makeThread({ labelIds: ["TRASH"] })} isSelected={false} onClick={onClick} />);
      expect(screen.queryByTestId("thread-folder")).not.toBeInTheDocument();
    });

    it("names Trash for a search hit in the trash", () => {
      render(
        <ThreadCard thread={makeThread({ labelIds: ["INBOX", "TRASH"] })} isSelected={false} onClick={onClick} showFolder />,
      );
      const tag = screen.getByTestId("thread-folder");
      expect(tag).toHaveTextContent("Trash");
      expect(tag.className).toContain("text-text-secondary");
    });

    it("names the user label a hit is filed under", () => {
      render(
        <ThreadCard thread={makeThread({ labelIds: ["Label_1"] })} isSelected={false} onClick={onClick} showFolder />,
      );
      expect(screen.getByTestId("thread-folder")).toHaveTextContent("Receipts");
    });

    it("does not add a redundant Inbox pill", () => {
      render(
        <ThreadCard thread={makeThread({ labelIds: ["INBOX"] })} isSelected={false} onClick={onClick} showFolder />,
      );
      expect(screen.queryByTestId("thread-folder")).not.toBeInTheDocument();
    });
  });
});
