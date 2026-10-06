import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ContextMenuPortal } from "./ContextMenuPortal";
import { useContextMenuStore } from "@/stores/contextMenuStore";
import { useTaskStore } from "@/stores/taskStore";
import { insertTask } from "@/services/db/tasks";
import { extractTask } from "@/services/ai/taskExtraction";
import { navigateToLabel } from "@/router/navigate";
import { useThreadStore } from "@/stores/threadStore";
import { getMessagesForThread } from "@/services/db/messages";
import { collectOwnAddresses } from "@/services/accounts/ownAddresses";
import { parseMailLink } from "@/utils/mailLink";
import { useToastStore } from "@/stores/toastStore";
import { useAccountStore } from "@/stores/accountStore";

const mockWriteText = vi.fn();
let activeLabel = "inbox";

vi.mock("@/router/navigate", () => ({ navigateToLabel: vi.fn(), getActiveLabel: () => activeLabel }));
vi.mock("@/services/db/tasks", () => ({
  insertTask: vi.fn().mockResolvedValue("created-task"),
  getIncompleteTaskCount: vi.fn().mockResolvedValue(1),
  getTasksForThread: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/services/db/messages", () => ({ getMessagesForThread: vi.fn().mockResolvedValue([]) }));
vi.mock("@/services/accounts/ownAddresses", () => ({ collectOwnAddresses: vi.fn().mockResolvedValue(["me@example.com"]) }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: (...args: unknown[]) => mockWriteText(...args) }));
vi.mock("@/services/ai/taskExtraction", () => ({ extractTask: vi.fn() }));

const threadFixture = {
  id: "thread-row", accountId: "row-account", subject: "Subject", snippet: "Snippet", lastMessageAt: 1,
  messageCount: 2, isRead: true, isStarred: false, isPinned: false, isMuted: false,
  hasAttachments: false, labelIds: ["INBOX"], fromName: "Friend", fromAddress: "friend@example.com",
};

const originalAccountState = useAccountStore.getState();

function messageFixture(id: string, date: number, from: string, accountId = "row-account", receipt = 0) {
  return { id, date, from_address: from, account_id: accountId, thread_id: "thread-row", is_read_receipt: receipt } as never;
}

function openThreadMenu(selectedIds = new Set<string>()) {
  useThreadStore.setState({ threads: [threadFixture], selectedThreadIds: selectedIds });
  useContextMenuStore.getState().openMenu("thread", { x: 40, y: 80 }, { threadId: "thread-row" });
}

async function copyFromThreadMenu() {
  render(<ContextMenuPortal />);
  fireEvent.click(screen.getByRole("menuitem", { name: "Copy Message Link" }));
  await waitFor(() => expect(mockWriteText).toHaveBeenCalled());
  return parseMailLink(mockWriteText.mock.calls.at(-1)![0] as string);
}

describe("thread menu message links", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activeLabel = "inbox";
    useToastStore.getState().clear();
    mockWriteText.mockResolvedValue(undefined);
    vi.mocked(getMessagesForThread).mockResolvedValue([]);
    useAccountStore.setState(originalAccountState);
    useThreadStore.setState({ threads: [], selectedThreadIds: new Set() });
    useContextMenuStore.getState().closeMenu();
  });

  it("copies the incoming Inbox message using the row account, despite a later reply", async () => {
    vi.mocked(getMessagesForThread).mockResolvedValue([
      messageFixture("incoming", 10, "friend@example.com"),
      messageFixture("outgoing", 20, "me@example.com"),
    ]);
    openThreadMenu();
    expect(await copyFromThreadMenu()).toEqual({ accountId: "row-account", threadId: "thread-row", messageId: "incoming" });
    expect(getMessagesForThread).toHaveBeenCalledWith("row-account", "thread-row");
    expect(collectOwnAddresses).toHaveBeenCalledWith(expect.any(Array), ["row-account"]);
    expect(useToastStore.getState().toasts[0]).toMatchObject({ kind: "success", title: "Message link copied" });
  });

  it("copies the latest sent message outside Inbox", async () => {
    vi.mocked(getMessagesForThread).mockResolvedValue([
      messageFixture("incoming", 10, "friend@example.com"),
      messageFixture("outgoing", 20, "me@example.com"),
    ]);
    activeLabel = "sent";
    openThreadMenu();
    expect(await copyFromThreadMenu()).toEqual({ accountId: "row-account", threadId: "thread-row", messageId: "outgoing" });
  });

  it("reports a graceful error when Inbox has no external non-receipt message", async () => {
    vi.mocked(getMessagesForThread).mockResolvedValue([
      messageFixture("receipt", 20, "friend@example.com", "row-account", 1),
    ]);
    openThreadMenu();
    render(<ContextMenuPortal />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy Message Link" }));
    await waitFor(() => expect(useToastStore.getState().toasts[0]).toMatchObject({
      kind: "error", title: "Could not copy message link",
    }));
    expect(mockWriteText).not.toHaveBeenCalled();
  });

  it("copies the latest own message when the Inbox thread has no external mail", async () => {
    vi.mocked(getMessagesForThread).mockResolvedValue([messageFixture("own", 10, "me@example.com")]);
    openThreadMenu();
    expect(await copyFromThreadMenu()).toEqual({ accountId: "row-account", threadId: "thread-row", messageId: "own" });
  });

  it("uses all listed mailbox identities in a unified row while linking with that row account", async () => {
    useAccountStore.setState({
      accounts: [
        { id: "other-account", email: "other@example.com", displayName: "Other", avatarUrl: null, isActive: true },
        { id: "row-account", email: "row@example.com", displayName: "Row", avatarUrl: null, isActive: true },
      ],
      activeAccountId: "other-account",
      unifiedInbox: true,
    });
    vi.mocked(collectOwnAddresses).mockResolvedValue(["other@example.com", "alias@row.example"]);
    vi.mocked(getMessagesForThread).mockResolvedValue([
      messageFixture("incoming", 10, "friend@example.com"),
      messageFixture("row-alias-reply", 20, "alias@row.example"),
    ]);
    openThreadMenu();
    expect(await copyFromThreadMenu()).toEqual({
      accountId: "row-account", threadId: "thread-row", messageId: "incoming",
    });
    expect(getMessagesForThread).toHaveBeenCalledWith("row-account", "thread-row");
    expect(collectOwnAddresses).toHaveBeenCalledWith(expect.any(Array), ["other-account", "row-account"]);
  });

  it("keeps clipboard failures in a persistent error toast without success", async () => {
    vi.mocked(getMessagesForThread).mockResolvedValue([messageFixture("incoming", 10, "friend@example.com")]);
    mockWriteText.mockRejectedValue(new Error("clipboard unavailable"));
    openThreadMenu();
    render(<ContextMenuPortal />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy Message Link" }));
    await waitFor(() => expect(useToastStore.getState().toasts[0]).toMatchObject({
      kind: "error", title: "Could not copy message link", detail: "clipboard unavailable", ttlMs: null,
    }));
    expect(useToastStore.getState().toasts.some((toast) => toast.kind === "success")).toBe(false);
  });

  it("hides the action for multiselect", () => {
    openThreadMenu(new Set(["thread-row", "another"]));
    render(<ContextMenuPortal />);
    expect(screen.queryByRole("menuitem", { name: "Copy Message Link" })).not.toBeInTheDocument();
  });
});

describe("selected email task actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getMessagesForThread).mockResolvedValue([]);
    useTaskStore.setState({ selectedTaskId: null });
    useContextMenuStore.getState().openMenu("textSelection", { x: 40, y: 80 }, {
      accountId: "mailbox", threadId: "source-thread", text: "Send the signed contract today",
    });
  });

  it("creates a linked task from the strip and opens its selected row in Tasks", async () => {
    render(<ContextMenuPortal />);
    fireEvent.click(screen.getByRole("button", { name: "Make task" }));
    await waitFor(() => expect(navigateToLabel).toHaveBeenCalledWith("tasks"));
    expect(insertTask).toHaveBeenCalledWith({
      accountId: "mailbox", threadAccountId: "mailbox", threadId: "source-thread",
      title: "Send the signed contract today",
    });
    expect(useTaskStore.getState().selectedTaskId).toBe("created-task");
  });

  it("creates an AI task from the right-click menu while retaining its source text", async () => {
    useContextMenuStore.setState({ data: { ...useContextMenuStore.getState().data, contextMenu: true } });
    vi.mocked(extractTask).mockResolvedValue({ title: "Send contract", description: "Get the signature", priority: "high", dueDate: null });
    render(<ContextMenuPortal />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Make AI task" }));
    await waitFor(() => expect(navigateToLabel).toHaveBeenCalledWith("tasks"));
    expect(extractTask).toHaveBeenCalledWith("source-thread", "mailbox", [], "Send the signed contract today");
    expect(insertTask).toHaveBeenCalledWith(expect.objectContaining({
      title: "Send contract", description: "Get the signature\n\nSelected text: Send the signed contract today",
      threadId: "source-thread", threadAccountId: "mailbox",
    }));
    expect(useTaskStore.getState().selectedTaskId).toBe("created-task");
  });
});
