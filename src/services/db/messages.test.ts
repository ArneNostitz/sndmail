import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/services/db/connection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/db/connection")>();
  return {
    ...actual,
    getDb: vi.fn(),
  };
});

import { getDb } from "@/services/db/connection";
import { deleteAllMessagesForAccount, updateMessageThreadIds, updateMissingMessageBody } from "./messages";
import { createMockDb } from "@/test/mocks";

const mockDb = createMockDb();

describe("messages service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockResolvedValue(mockDb as unknown as Awaited<ReturnType<typeof getDb>>);
  });

  describe("deleteAllMessagesForAccount", () => {
    it("deletes all messages for the given account", async () => {
      await deleteAllMessagesForAccount("acc-1");

      expect(mockDb.execute).toHaveBeenCalledWith(
        "DELETE FROM messages WHERE account_id = $1",
        ["acc-1"],
      );
    });
  });

  describe("updateMessageThreadIds", () => {
    it("updates thread_id for a small batch of messages", async () => {
      await updateMessageThreadIds("acc-1", ["msg-1", "msg-2", "msg-3"], "thread-abc");

      expect(mockDb.execute).toHaveBeenCalledTimes(1);
      expect(mockDb.execute).toHaveBeenCalledWith(
        "UPDATE messages SET thread_id = $1 WHERE account_id = $2 AND id IN ($3, $4, $5)",
        ["thread-abc", "acc-1", "msg-1", "msg-2", "msg-3"],
      );
    });

    it("chunks large batches to stay within SQLite variable limit", async () => {
      // Create 1200 message IDs to force 3 chunks (500 + 500 + 200)
      const messageIds = Array.from({ length: 1200 }, (_, i) => `msg-${i}`);
      await updateMessageThreadIds("acc-1", messageIds, "thread-xyz");

      expect(mockDb.execute).toHaveBeenCalledTimes(3);

      // First chunk: 500 messages
      const firstCall = mockDb.execute.mock.calls[0]!;
      const firstPlaceholders = (firstCall[0] as string).match(/\$\d+/g)!;
      // $1 (threadId) + $2 (accountId) + 500 message placeholders = 502
      expect(firstPlaceholders).toHaveLength(502);
      expect(firstCall[1]).toHaveLength(502); // threadId + accountId + 500 IDs

      // Second chunk: 500 messages
      const secondCall = mockDb.execute.mock.calls[1]!;
      expect(secondCall[1]).toHaveLength(502);

      // Third chunk: 200 messages
      const thirdCall = mockDb.execute.mock.calls[2]!;
      expect(thirdCall[1]).toHaveLength(202); // threadId + accountId + 200 IDs
    });

    it("handles empty message list without calling db", async () => {
      await updateMessageThreadIds("acc-1", [], "thread-abc");

      expect(mockDb.execute).not.toHaveBeenCalled();
    });

    it("handles exactly 500 messages in a single chunk", async () => {
      const messageIds = Array.from({ length: 500 }, (_, i) => `msg-${i}`);
      await updateMessageThreadIds("acc-1", messageIds, "thread-abc");

      expect(mockDb.execute).toHaveBeenCalledTimes(1);
    });

    it("handles 501 messages in two chunks", async () => {
      const messageIds = Array.from({ length: 501 }, (_, i) => `msg-${i}`);
      await updateMessageThreadIds("acc-1", messageIds, "thread-abc");

      expect(mockDb.execute).toHaveBeenCalledTimes(2);

      // Second chunk should have just 1 message
      const secondCall = mockDb.execute.mock.calls[1]!;
      expect(secondCall[1]).toHaveLength(3); // threadId + accountId + 1 ID
    });
  });

  it("fills missing HTML while preserving already-cached text", async () => {
    await updateMissingMessageBody("account-1", "message-1", "<p>Formatted</p>", "fetched text");

    const [sql, params] = mockDb.execute.mock.calls[mockDb.execute.mock.calls.length - 1]!;
    expect(sql).toContain("body_text = CASE WHEN body_text IS NULL OR body_text = '' THEN COALESCE($2, body_text) ELSE body_text END");
    expect(sql).toContain("AND ((body_html IS NULL OR body_html = '') OR (body_text IS NULL OR body_text = ''))");
    expect(params).toEqual(["<p>Formatted</p>", "fetched text", "account-1", "message-1"]);
  });
});
