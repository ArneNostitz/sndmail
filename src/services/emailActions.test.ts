import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock dependencies
vi.mock("@/stores/uiStore", () => ({
  useUIStore: {
    getState: vi.fn(() => ({ isOnline: true })),
  },
}));

vi.mock("@/stores/threadStore", () => ({
  useThreadStore: {
    getState: vi.fn(() => ({
      updateThread: vi.fn(),
      removeThread: vi.fn(),
      beginThreadRemoval: vi.fn(),
    })),
  },
}));

vi.mock("@/services/email/providerFactory", () => ({
  getEmailProvider: vi.fn(),
}));

vi.mock("@/services/db/pendingOperations", () => ({
  enqueuePendingOperation: vi.fn(() => Promise.resolve("op-1")),
}));

vi.mock("@/services/db/connection", () => ({
  getDb: vi.fn(() =>
    Promise.resolve({
      execute: vi.fn(() => Promise.resolve()),
      select: vi.fn(() => Promise.resolve([])),
    }),
  ),
}));

vi.mock("@/services/db/messages", () => ({ upsertMessage: vi.fn(() => Promise.resolve()) }));
vi.mock("@/services/db/threads", () => ({
  upsertThread: vi.fn(() => Promise.resolve()),
  setThreadLabels: vi.fn(() => Promise.resolve()),
  getThreadLabelIds: vi.fn(() => Promise.resolve(["INBOX"])),
}));
vi.mock("@/services/db/accounts", () => ({ getAccount: vi.fn(() => Promise.resolve(null)) }));

vi.mock("@/router/navigate", () => ({
  navigateToThread: vi.fn(),
  getActiveLabel: vi.fn(() => "inbox"),
  getSelectedThreadId: vi.fn(() => null),
}));

import { useUIStore } from "@/stores/uiStore";
import { useThreadStore } from "@/stores/threadStore";
import { getEmailProvider } from "@/services/email/providerFactory";
import { enqueuePendingOperation } from "@/services/db/pendingOperations";
import {
  archiveThread,
  trashThread,
  permanentDeleteThread,
  starThread,
  markThreadRead,
  spamThread,
  moveThread,
  executeEmailAction,
  sendEmail,
  runBulkAction,
} from "./emailActions";
import { getDb } from "@/services/db/connection";
import { navigateToThread, getActiveLabel, getSelectedThreadId } from "@/router/navigate";
import { createMockEmailProvider, createMockUIStoreState, createMockThreadStoreState } from "@/test/mocks";

const mockProvider = createMockEmailProvider();

const mockUpdateThread = vi.fn();
const mockRemoveThread = vi.fn();

describe("emailActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getEmailProvider).mockResolvedValue(mockProvider as never);
    vi.mocked(useUIStore.getState).mockReturnValue(createMockUIStoreState() as never);
    vi.mocked(useThreadStore.getState).mockReturnValue(createMockThreadStoreState({
      updateThread: mockUpdateThread,
      removeThread: mockRemoveThread,
      beginThreadRemoval: mockRemoveThread,
    }) as never);
  });

  it("persists and announces a sent message after provider send succeeds", async () => {
    const sentMessage = {
      id: "sent-1", threadId: "t1", fromAddress: "me@example.com", fromName: "Me",
      toAddresses: "them@example.com", ccAddresses: null, bccAddresses: null, replyTo: null,
      subject: "Re: Hello", snippet: "Thanks", date: 1234, isRead: true, isStarred: false,
      bodyHtml: "<p>Thanks</p>", bodyText: "Thanks", rawSize: 20, internalDate: 1234,
      labelIds: ["SENT"], hasAttachments: false, attachments: [], listUnsubscribe: null,
      listUnsubscribePost: null, authResults: null, messageIdHeader: "<sent@example.com>",
      inReplyToHeader: "<original@example.com>", referencesHeader: null, dispositionNotificationTo: null,
      mdnReport: null,
    };
    const provider = { ...mockProvider, sendMessage: vi.fn().mockResolvedValue({ id: "sent-1" }), fetchMessage: vi.fn().mockResolvedValue(sentMessage) };
    vi.mocked(getEmailProvider).mockResolvedValue(provider as never);
    const listener = vi.fn();
    window.addEventListener("sndmail-message-sent", listener);

    const result = await sendEmail("acct-1", "raw", "t1");

    expect(result.success).toBe(true);
    expect(provider.fetchMessage).toHaveBeenCalledWith("sent-1");
    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0]![0] as CustomEvent).detail).toEqual({ accountId: "acct-1", threadId: "t1", messageId: "sent-1" });
    window.removeEventListener("sndmail-message-sent", listener);
  });

  it("does not announce a queued send before it is actually sent", async () => {
    vi.mocked(useUIStore.getState).mockReturnValue(createMockUIStoreState({ isOnline: false }) as never);
    const listener = vi.fn();
    window.addEventListener("sndmail-message-sent", listener);
    const result = await sendEmail("acct-1", "raw", "t1");
    expect(result.queued).toBe(true);
    expect(listener).not.toHaveBeenCalled();
    window.removeEventListener("sndmail-message-sent", listener);
  });

  describe("online execution", () => {
    it("archives a thread via provider", async () => {
      const result = await archiveThread("acct-1", "t1", ["m1"]);
      expect(result.success).toBe(true);
      expect(result.queued).toBeUndefined();
      expect(mockRemoveThread).toHaveBeenCalledWith("t1");
      expect(mockProvider.archive).toHaveBeenCalledWith("t1", ["m1"]);
    });

    it("trashes a thread via provider", async () => {
      const result = await trashThread("acct-1", "t1", ["m1"]);
      expect(result.success).toBe(true);
      expect(mockProvider.trash).toHaveBeenCalledWith("t1", ["m1"]);
    });

    it("stars a thread via provider", async () => {
      const result = await starThread("acct-1", "t1", ["m1"], true);
      expect(result.success).toBe(true);
      expect(mockUpdateThread).toHaveBeenCalledWith("t1", { isStarred: true });
      expect(mockProvider.star).toHaveBeenCalledWith("t1", ["m1"], true);
    });

    it("marks thread read via provider", async () => {
      const result = await markThreadRead("acct-1", "t1", ["m1"], true);
      expect(result.success).toBe(true);
      expect(mockUpdateThread).toHaveBeenCalledWith("t1", { isRead: true });
      expect(mockProvider.markRead).toHaveBeenCalledWith("t1", ["m1"], true);
    });

    it("reports spam via provider", async () => {
      const result = await spamThread("acct-1", "t1", ["m1"], true);
      expect(result.success).toBe(true);
      expect(mockRemoveThread).toHaveBeenCalledWith("t1");
      expect(mockProvider.spam).toHaveBeenCalledWith("t1", ["m1"], true);
    });

    it("keeps a restored thread visible outside the Spam folder", async () => {
      const spamThreadRecord = {
        id: "t1",
        labelIds: ["SPAM", "UNREAD"],
      };
      vi.mocked(useThreadStore.getState).mockReturnValue(createMockThreadStoreState({
        threads: [spamThreadRecord],
        threadMap: new Map([["t1", spamThreadRecord]]),
        updateThread: mockUpdateThread,
        removeThread: mockRemoveThread,
        beginThreadRemoval: mockRemoveThread,
      }) as never);
      vi.mocked(getActiveLabel).mockReturnValue("inbox");

      await spamThread("acct-1", "t1", ["m1"], false);

      expect(mockRemoveThread).not.toHaveBeenCalled();
      expect(mockUpdateThread).toHaveBeenCalledWith("t1", {
        labelIds: ["UNREAD", "INBOX"],
      });
    });

    it("removes a restored thread from the Spam folder", async () => {
      vi.mocked(getActiveLabel).mockReturnValue("spam");

      await spamThread("acct-1", "t1", ["m1"], false);

      expect(mockRemoveThread).toHaveBeenCalledWith("t1");
    });
  });

  describe("offline queueing", () => {
    beforeEach(() => {
      vi.mocked(useUIStore.getState).mockReturnValue({ isOnline: false } as never);
    });

    it("queues archive when offline", async () => {
      const result = await archiveThread("acct-1", "t1", ["m1"]);
      expect(result.success).toBe(true);
      expect(result.queued).toBe(true);
      expect(mockProvider.archive).not.toHaveBeenCalled();
      expect(enqueuePendingOperation).toHaveBeenCalledWith(
        "acct-1",
        "archive",
        "t1",
        expect.objectContaining({ threadId: "t1", messageIds: ["m1"] }),
      );
    });

    it("still applies optimistic UI update when offline", async () => {
      await starThread("acct-1", "t1", ["m1"], true);
      expect(mockUpdateThread).toHaveBeenCalledWith("t1", { isStarred: true });
    });
  });

  describe("network error → queue fallback", () => {
    it("queues on retryable network error", async () => {
      vi.mocked(useUIStore.getState).mockReturnValue({ isOnline: true } as never);
      mockProvider.archive.mockRejectedValueOnce(new Error("Failed to fetch"));

      const result = await archiveThread("acct-1", "t1", ["m1"]);
      expect(result.success).toBe(true);
      expect(result.queued).toBe(true);
      expect(enqueuePendingOperation).toHaveBeenCalled();
    });
  });

  describe("permanent error → revert", () => {
    it("reverts star on permanent error", async () => {
      vi.mocked(useUIStore.getState).mockReturnValue({ isOnline: true } as never);
      mockProvider.star.mockRejectedValueOnce(new Error("Invalid request"));

      const result = await starThread("acct-1", "t1", ["m1"], true);
      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
      // Revert: set starred to false
      expect(mockUpdateThread).toHaveBeenCalledWith("t1", { isStarred: false });
    });

    it("reverts markRead on permanent error", async () => {
      vi.mocked(useUIStore.getState).mockReturnValue({ isOnline: true } as never);
      mockProvider.markRead.mockRejectedValueOnce(new Error("Bad request"));

      const result = await markThreadRead("acct-1", "t1", ["m1"], true);
      expect(result.success).toBe(false);
      // Revert: set read to false
      expect(mockUpdateThread).toHaveBeenCalledWith("t1", { isRead: false });
    });
  });

  describe("auto-advance after removal", () => {
    const threads = [
      { id: "t1" },
      { id: "t2" },
      { id: "t3" },
    ];

    it("navigates to next thread when archiving the viewed thread", async () => {
      vi.mocked(getSelectedThreadId).mockReturnValue("t2");
      vi.mocked(useThreadStore.getState).mockReturnValue(createMockThreadStoreState({
        threads,
        updateThread: mockUpdateThread,
        removeThread: mockRemoveThread,
        beginThreadRemoval: mockRemoveThread,
      }) as never);

      await archiveThread("acct-1", "t2", ["m1"]);
      expect(navigateToThread).toHaveBeenCalledWith("t3");
    });

    it("navigates to previous thread when archiving the last thread", async () => {
      vi.mocked(getSelectedThreadId).mockReturnValue("t3");
      vi.mocked(useThreadStore.getState).mockReturnValue(createMockThreadStoreState({
        threads,
        updateThread: mockUpdateThread,
        removeThread: mockRemoveThread,
        beginThreadRemoval: mockRemoveThread,
      }) as never);

      await archiveThread("acct-1", "t3", ["m1"]);
      expect(navigateToThread).toHaveBeenCalledWith("t2");
    });

    it("does not navigate when archiving a non-viewed thread", async () => {
      vi.mocked(getSelectedThreadId).mockReturnValue("t1");
      vi.mocked(useThreadStore.getState).mockReturnValue(createMockThreadStoreState({
        threads,
        updateThread: mockUpdateThread,
        removeThread: mockRemoveThread,
        beginThreadRemoval: mockRemoveThread,
      }) as never);

      await archiveThread("acct-1", "t2", ["m1"]);
      expect(navigateToThread).not.toHaveBeenCalled();
    });

    it("does not navigate when archiving the only thread", async () => {
      vi.mocked(getSelectedThreadId).mockReturnValue("t1");
      vi.mocked(useThreadStore.getState).mockReturnValue(createMockThreadStoreState({
        threads: [{ id: "t1" }],
        updateThread: mockUpdateThread,
        removeThread: mockRemoveThread,
        beginThreadRemoval: mockRemoveThread,
      }) as never);

      await archiveThread("acct-1", "t1", ["m1"]);
      expect(navigateToThread).not.toHaveBeenCalled();
    });

    it("navigates on trash action", async () => {
      vi.mocked(getSelectedThreadId).mockReturnValue("t1");
      vi.mocked(useThreadStore.getState).mockReturnValue(createMockThreadStoreState({
        threads,
        updateThread: mockUpdateThread,
        removeThread: mockRemoveThread,
        beginThreadRemoval: mockRemoveThread,
      }) as never);

      await trashThread("acct-1", "t1", ["m1"]);
      expect(navigateToThread).toHaveBeenCalledWith("t2");
    });

    it("navigates on spam action", async () => {
      vi.mocked(getSelectedThreadId).mockReturnValue("t1");
      vi.mocked(useThreadStore.getState).mockReturnValue(createMockThreadStoreState({
        threads,
        updateThread: mockUpdateThread,
        removeThread: mockRemoveThread,
        beginThreadRemoval: mockRemoveThread,
      }) as never);

      await spamThread("acct-1", "t1", ["m1"], true);
      expect(navigateToThread).toHaveBeenCalledWith("t2");
    });

    it("navigates on permanentDelete action", async () => {
      vi.mocked(getSelectedThreadId).mockReturnValue("t2");
      vi.mocked(useThreadStore.getState).mockReturnValue(createMockThreadStoreState({
        threads,
        updateThread: mockUpdateThread,
        removeThread: mockRemoveThread,
        beginThreadRemoval: mockRemoveThread,
      }) as never);

      await permanentDeleteThread("acct-1", "t2", ["m1"]);
      expect(navigateToThread).toHaveBeenCalledWith("t3");
    });

    it("navigates on moveToFolder action", async () => {
      vi.mocked(getSelectedThreadId).mockReturnValue("t2");
      vi.mocked(useThreadStore.getState).mockReturnValue(createMockThreadStoreState({
        threads,
        updateThread: mockUpdateThread,
        removeThread: mockRemoveThread,
        beginThreadRemoval: mockRemoveThread,
      }) as never);

      await moveThread("acct-1", "t2", ["m1"], "Archive");
      expect(navigateToThread).toHaveBeenCalledWith("t3");
    });
  });

  describe("executeEmailAction with draft actions", () => {
    it("sends a message via provider", async () => {
      const result = await executeEmailAction("acct-1", {
        type: "sendMessage",
        rawBase64Url: "base64data",
        threadId: "t1",
      });
      expect(result.success).toBe(true);
      expect(mockProvider.sendMessage).toHaveBeenCalledWith("base64data", "t1");
    });

    it("creates a draft via provider", async () => {
      const result = await executeEmailAction("acct-1", {
        type: "createDraft",
        rawBase64Url: "base64data",
      });
      expect(result.success).toBe(true);
      expect(mockProvider.createDraft).toHaveBeenCalledWith("base64data", undefined);
    });
  });

  describe("message ids", () => {
    it("fills in the thread's message ids when the caller passed none", async () => {
      // The IMAP provider moves messages, not threads: with no ids it moved
      // nothing and the mail stayed on the server
      vi.mocked(getDb).mockResolvedValueOnce({
        execute: vi.fn(() => Promise.resolve()),
        select: vi.fn(() => Promise.resolve([{ id: "imap-a-INBOX-1" }, { id: "imap-a-INBOX-2" }])),
      } as never);
      await trashThread("acct-1", "t1", []);
      expect(mockProvider.trash).toHaveBeenCalledWith("t1", ["imap-a-INBOX-1", "imap-a-INBOX-2"]);
    });

    it("queues the resolved ids so a replay after the rows are gone still works", async () => {
      vi.mocked(getDb).mockResolvedValueOnce({
        execute: vi.fn(() => Promise.resolve()),
        select: vi.fn(() => Promise.resolve([{ id: "m9" }])),
      } as never);
      vi.mocked(useUIStore.getState).mockReturnValue({ isOnline: false } as never);
      await archiveThread("acct-1", "t1", []);
      expect(enqueuePendingOperation).toHaveBeenCalledWith(
        "acct-1",
        "archive",
        "t1",
        expect.objectContaining({ messageIds: ["m9"] }),
      );
    });

    it("leaves ids the caller supplied alone", async () => {
      await trashThread("acct-1", "t1", ["m1"]);
      expect(mockProvider.trash).toHaveBeenCalledWith("t1", ["m1"]);
    });
  });

  describe("runBulkAction", () => {
    const targets = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ accountId: "acct-1", threadId: `t${i}` }));

    it("fades every row out before the first server call returns", async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const run = vi.fn(() => gate);
      const done = runBulkAction(targets(3), run, { removes: true });
      expect(mockRemoveThread).toHaveBeenCalledWith(["t0", "t1", "t2"]);
      release();
      await done;
    });

    it("runs calls concurrently, bounded by the limit", async () => {
      let inFlight = 0;
      let peak = 0;
      const run = vi.fn(async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
      });
      await runBulkAction(targets(10), run, { concurrency: 4 });
      expect(run).toHaveBeenCalledTimes(10);
      expect(peak).toBe(4);
    });

    it("keeps going past a failure and counts it", async () => {
      const run = vi.fn(async ({ threadId }: { threadId: string }) => {
        if (threadId === "t1") throw new Error("boom");
      });
      const result = await runBulkAction(targets(3), run);
      expect(run).toHaveBeenCalledTimes(3);
      expect(result.failed).toBe(1);
    });

    it("does nothing for an empty selection", async () => {
      const run = vi.fn();
      await runBulkAction([], run, { removes: true });
      expect(run).not.toHaveBeenCalled();
      expect(mockRemoveThread).not.toHaveBeenCalled();
    });
  });
});
