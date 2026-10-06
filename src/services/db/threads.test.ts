import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/services/db/connection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/db/connection")>();
  return {
    ...actual,
    getDb: vi.fn(),
  };
});

import { getDb } from "@/services/db/connection";
import {
  muteThread,
  unmuteThread,
  getMutedThreadIds,
  deleteAllThreadsForAccount,
  getThreadsForAccounts,
  getThreadsForCategoryAcrossAccounts,
  getThreadsWithContact,
  setThreadLabels,
  mergeThreads,
  unmergeThread,
  getMergedThreadIds,
} from "./threads";
import { createMockDb } from "@/test/mocks";

const mockDb = createMockDb();

describe("threads service - deleteAllThreadsForAccount", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockResolvedValue(mockDb as unknown as Awaited<ReturnType<typeof getDb>>);
  });

  it("deletes all threads for the given account", async () => {
    await deleteAllThreadsForAccount("acc-1");

    expect(mockDb.execute).toHaveBeenCalledWith(
      "DELETE FROM threads WHERE account_id = $1",
      ["acc-1"],
    );
  });
});

describe("threads service - mute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockResolvedValue(mockDb as unknown as Awaited<ReturnType<typeof getDb>>);
  });

  describe("muteThread", () => {
    it("calls db.execute with correct SQL to set is_muted = 1", async () => {
      await muteThread("acc-1", "thread-1");

      expect(mockDb.execute).toHaveBeenCalledWith(
        "UPDATE threads SET is_muted = 1 WHERE account_id = $1 AND id = $2",
        ["acc-1", "thread-1"],
      );
    });
  });

  describe("unmuteThread", () => {
    it("calls db.execute with correct SQL to set is_muted = 0", async () => {
      await unmuteThread("acc-1", "thread-1");

      expect(mockDb.execute).toHaveBeenCalledWith(
        "UPDATE threads SET is_muted = 0 WHERE account_id = $1 AND id = $2",
        ["acc-1", "thread-1"],
      );
    });
  });

  describe("getMutedThreadIds", () => {
    it("returns a Set of muted thread IDs", async () => {
      mockDb.select.mockResolvedValueOnce([
        { id: "thread-1" },
        { id: "thread-3" },
      ]);

      const result = await getMutedThreadIds("acc-1");

      expect(mockDb.select).toHaveBeenCalledWith(
        "SELECT id FROM threads WHERE account_id = $1 AND is_muted = 1",
        ["acc-1"],
      );
      expect(result).toBeInstanceOf(Set);
      expect(result.size).toBe(2);
      expect(result.has("thread-1")).toBe(true);
      expect(result.has("thread-3")).toBe(true);
    });

    it("returns an empty Set when no threads are muted", async () => {
      mockDb.select.mockResolvedValueOnce([]);

      const result = await getMutedThreadIds("acc-1");

      expect(result.size).toBe(0);
    });
  });
});


describe("threads service - unified inbox queries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockResolvedValue(mockDb as unknown as Awaited<ReturnType<typeof getDb>>);
    mockDb.select.mockResolvedValue([]);
  });

  /** The SQL and bound parameters of the last select. */
  function lastSelect(): { sql: string; params: unknown[] } {
    const call = mockDb.select.mock.calls.at(-1)!;
    return { sql: call[0] as string, params: call[1] as unknown[] };
  }

  it("does not query at all for an empty account list", async () => {
    await expect(getThreadsForAccounts([])).resolves.toEqual([]);
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("binds one placeholder per account, then limit and offset", async () => {
    await getThreadsForAccounts(["a", "b", "c"], undefined, 25, 50);
    const { sql, params } = lastSelect();
    expect(sql).toContain("t.account_id IN ($1, $2, $3)");
    expect(sql).toContain("LIMIT $4 OFFSET $5");
    expect(params).toEqual(["a", "b", "c", 25, 50]);
  });

  it("numbers the label placeholder after the accounts", async () => {
    await getThreadsForAccounts(["a", "b"], "INBOX", 10, 0);
    const { sql, params } = lastSelect();
    expect(sql).toContain("t.account_id IN ($1, $2)");
    expect(sql).toContain("tl.label_id IN ($3)");
    expect(sql).toContain("LIMIT $4 OFFSET $5");
    expect(params).toEqual(["a", "b", "INBOX", 10, 0]);
  });

  it("keeps mixed INBOX and SPAM threads out of the inbox", async () => {
    await getThreadsForAccounts(["a"], "INBOX", 50, 0);
    const { sql } = lastSelect();
    expect(sql).toContain("NOT EXISTS");
    expect(sql).toContain("spam.label_id = 'SPAM'");
  });

  it("orders inbox threads by the latest message from someone else", async () => {
    await getThreadsForAccounts(["a"], "INBOX", 50, 0, ["me@x.com"]);
    const { sql, params } = lastSelect();
    expect(sql).toContain("COALESCE(");
    expect(sql).toContain("MAX(received.date)");
    expect(sql).toContain("LOWER(TRIM(COALESCE(received.from_address, ''))) NOT IN ($3)");
    expect(sql).toContain("t.last_message_at\n  ) DESC");
    expect(sql).toContain(") AS inbox_message_at");
    expect(params).toEqual(["a", "INBOX", "me@x.com", 50, 0]);
  });

  it("filters the peer row itself, not only the peer timestamp subquery", async () => {
    await getThreadsForAccounts(["a"], "INBOX", 50, 0, ["me@x.com"]);
    const { sql } = lastSelect();
    expect(sql).toContain("LOWER(TRIM(COALESCE(pm.from_address, ''))) NOT IN ($3)");
  });

  it("keeps the legacy order when own addresses are unavailable", async () => {
    await getThreadsForAccounts(["a"], "INBOX", 50, 0, []);
    expect(lastSelect().sql).toContain("ORDER BY t.is_pinned DESC, t.last_message_at DESC");
  });

  it("selects the inbox display date for the inbox list only", async () => {
    await getThreadsForAccounts(["a"], "INBOX", 50, 0, ["me@x.com"]);
    expect(lastSelect().sql).toContain("AS inbox_message_at");

    await getThreadsForAccounts(["a"], "SENT", 50, 0, ["me@x.com"]);
    expect(lastSelect().sql).not.toContain("AS inbox_message_at");
  });

  it("does not exclude spam threads from the spam folder", async () => {
    await getThreadsForAccounts(["a"], "SPAM", 50, 0);
    const { sql } = lastSelect();
    expect(sql).not.toContain("spam.label_id = 'SPAM'");
  });

  it("still works for a single account", async () => {
    await getThreadsForAccounts(["only"], "SENT", 50, 0);
    const { sql, params } = lastSelect();
    expect(sql).toContain("t.account_id IN ($1)");
    expect(params).toEqual(["only", "SENT", 50, 0]);
  });

  it("treats Primary as including uncategorized threads", async () => {
    await getThreadsForCategoryAcrossAccounts(["a", "b"], "Primary", 50, 0);
    const { sql, params } = lastSelect();
    expect(sql).toContain("t.account_id IN ($1, $2)");
    expect(sql).toContain("tc.category IS NULL OR tc.category = 'Primary'");
    expect(sql).toContain("LIMIT $3 OFFSET $4");
    expect(params).toEqual(["a", "b", 50, 0]);
    expect(sql).toContain("spam.label_id = 'SPAM'");
  });

  it("uses received-message time for categorized inbox ordering", async () => {
    await getThreadsForCategoryAcrossAccounts(["a"], "Primary", 50, 0, ["me@x.com"]);
    const { sql, params } = lastSelect();
    expect(sql).toContain("MAX(received.date)");
    expect(sql).toContain("NOT IN ($2)");
    expect(sql).toContain("AS inbox_message_at");
    expect(params).toEqual(["a", "me@x.com", 50, 0]);
  });

  it("binds the category after the accounts for other categories", async () => {
    await getThreadsForCategoryAcrossAccounts(["a", "b", "c"], "Promotions", 20, 40);
    const { sql, params } = lastSelect();
    expect(sql).toContain("t.account_id IN ($1, $2, $3)");
    expect(sql).toContain("tc.category = $4");
    expect(sql).toContain("LIMIT $5 OFFSET $6");
    expect(params).toEqual(["a", "b", "c", "Promotions", 20, 40]);
  });

  it("orders across accounts by date rather than grouping by mailbox", async () => {
    await getThreadsForAccounts(["a", "b"]);
    const { sql } = lastSelect();
    expect(sql).toContain("ORDER BY t.is_pinned DESC, t.last_message_at DESC");
  });

  it("skips the category query for an empty account list", async () => {
    await expect(getThreadsForCategoryAcrossAccounts([], "Primary")).resolves.toEqual([]);
    expect(mockDb.select).not.toHaveBeenCalled();
  });
});

describe("threads service - spam label invariant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockResolvedValue(mockDb as unknown as Awaited<ReturnType<typeof getDb>>);
  });

  it("does not persist INBOX beside SPAM", async () => {
    await setThreadLabels("acc-1", "thread-1", ["INBOX", "SPAM", "UNREAD"]);

    const insertedLabels = mockDb.execute.mock.calls
      .filter(([sql]) => String(sql).startsWith("INSERT"))
      .map(([, params]) => (params as unknown[])[2]);
    expect(insertedLabels).toEqual(["SPAM", "UNREAD"]);
  });
});


describe("threads service - naming the other party", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockResolvedValue(mockDb as unknown as Awaited<ReturnType<typeof getDb>>);
    mockDb.select.mockResolvedValue([]);
  });

  function lastSelect(): { sql: string; params: unknown[] } {
    const call = mockDb.select.mock.calls.at(-1)!;
    return { sql: call[0] as string, params: call[1] as unknown[] };
  }

  it("does not join for the other party when no own addresses are known", async () => {
    await getThreadsForAccounts(["a"], "INBOX", 50, 0, []);
    const { sql, params } = lastSelect();
    expect(sql).not.toContain("peer_address");
    expect(params).toEqual(["a", "INBOX", 50, 0]);
  });

  it("selects the last message that is not from the user", async () => {
    await getThreadsForAccounts(["a"], "INBOX", 50, 0, ["me@x.com", "alias@y.com"]);
    const { sql, params } = lastSelect();
    expect(sql).toContain("peer_address");
    expect(sql).toContain("NOT IN ($3, $4)");
    expect(sql).toContain("LIMIT $5 OFFSET $6");
    expect(params).toEqual(["a", "INBOX", "me@x.com", "alias@y.com", 50, 0]);
  });

  it("compares addresses case-insensitively", async () => {
    await getThreadsForAccounts(["a"], undefined, 50, 0, ["Me@X.com"]);
    const { sql, params } = lastSelect();
    expect(sql).toContain("LOWER(TRIM(COALESCE(m3.from_address, '')))");
    expect(params).toContain("me@x.com");
  });

  it("numbers placeholders correctly for the category query", async () => {
    await getThreadsForCategoryAcrossAccounts(["a", "b"], "Promotions", 25, 5, ["me@x.com"]);
    const { sql, params } = lastSelect();
    expect(sql).toContain("t.account_id IN ($1, $2)");
    expect(sql).toContain("tc.category = $3");
    expect(sql).toContain("NOT IN ($4)");
    expect(sql).toContain("LIMIT $5 OFFSET $6");
    expect(params).toEqual(["a", "b", "Promotions", "me@x.com", 25, 5]);
  });

  it("numbers placeholders correctly for the Primary query", async () => {
    await getThreadsForCategoryAcrossAccounts(["a"], "Primary", 50, 0, ["me@x.com"]);
    const { sql, params } = lastSelect();
    expect(sql).toContain("NOT IN ($2)");
    expect(sql).toContain("LIMIT $3 OFFSET $4");
    expect(params).toEqual(["a", "me@x.com", 50, 0]);
  });
});

describe("threads service - getThreadsWithContact", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockResolvedValue(mockDb as unknown as Awaited<ReturnType<typeof getDb>>);
    mockDb.select.mockResolvedValue([]);
  });

  function lastSelect(): { sql: string; params: unknown[] } {
    const call = mockDb.select.mock.calls.at(-1)!;
    return { sql: call[0] as string, params: call[1] as unknown[] };
  }

  it("counts only mail exchanged directly with the person", async () => {
    await getThreadsWithContact("acc-1", "Sam@Example.com", "thread-1", ["me@x.com"], 10, 0);
    const { sql, params } = lastSelect();
    // Their mail must be addressed to the user, and the user's to them
    expect(sql).toContain("mc.from_address, '')) = $3 AND (LOWER(COALESCE(mc.to_addresses");
    expect(sql).toContain("mc.from_address, '')) IN ($5)");
    expect(params).toEqual([
      "acc-1",
      "thread-1",
      "sam@example.com",
      "%sam@example.com%",
      "me@x.com",
      "%me@x.com%",
      10,
      0,
    ]);
  });

  it("never matches on Cc — sharing a Cc is not a conversation", async () => {
    await getThreadsWithContact("acc-1", "sam@example.com", null, ["me@x.com"]);
    expect(lastSelect().sql).not.toContain("cc_addresses");
  });

  it("leaves out drafts, trash and spam", async () => {
    await getThreadsWithContact("acc-1", "sam@example.com", null, ["me@x.com"]);
    const { sql } = lastSelect();
    expect(sql).toContain("'DRAFT', 'TRASH', 'SPAM'");
  });

  it("leaves out threads that are nothing but read receipts", async () => {
    await getThreadsWithContact("acc-1", "sam@example.com", null, ["me@x.com"]);
    expect(lastSelect().sql).toContain("mr.is_read_receipt = 0");
  });

  it("falls back to either direction when no own address is known", async () => {
    await getThreadsWithContact("acc-1", "sam@example.com", null, []);
    const { sql, params } = lastSelect();
    expect(sql).toContain("LOWER(COALESCE(mc.from_address, '')) = $3");
    expect(params).toEqual(["acc-1", null, "sam@example.com", "%sam@example.com%", 25, 0]);
  });

  it("excludes the thread already on screen", async () => {
    await getThreadsWithContact("acc-1", "sam@example.com", "thread-1", ["me@x.com"]);
    expect(lastSelect().sql).toContain("t.id != $2");
  });

  it("does not query without an address", async () => {
    expect(await getThreadsWithContact("acc-1", "", null, ["me@x.com"])).toEqual([]);
    expect(mockDb.select).not.toHaveBeenCalled();
  });
});

describe("threads service - hiding receipt-only threads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockResolvedValue(mockDb as unknown as Awaited<ReturnType<typeof getDb>>);
    mockDb.select.mockResolvedValue([]);
  });

  it("keeps them out of a label list", async () => {
    await getThreadsForAccounts(["a"], "INBOX", 50, 0, []);
    expect(mockDb.select.mock.calls.at(-1)![0]).toContain("mr.is_read_receipt = 0");
  });

  it("keeps them out of a category list", async () => {
    await getThreadsForCategoryAcrossAccounts(["a"], "Primary", 50, 0, []);
    expect(mockDb.select.mock.calls.at(-1)![0]).toContain("mr.is_read_receipt = 0");
  });
});

describe("threads service - combined Inbox + Sent view", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockResolvedValue(mockDb as unknown as Awaited<ReturnType<typeof getDb>>);
    mockDb.select.mockResolvedValue([]);
  });

  function lastSelect(): { sql: string; params: unknown[] } {
    const call = mockDb.select.mock.calls.at(-1)!;
    return { sql: call[0] as string, params: call[1] as unknown[] };
  }

  it("draws one date-ordered list from several labels", async () => {
    await getThreadsForAccounts(["a"], ["INBOX", "SENT"], 50, 0, []);
    const { sql, params } = lastSelect();
    expect(sql).toContain("tl.label_id IN ($2, $3)");
    expect(sql).toContain("ORDER BY t.is_pinned DESC, t.last_message_at DESC");
    expect(params).toEqual(["a", "INBOX", "SENT", 50, 0]);
  });

  it("still takes a single label as a plain string", async () => {
    await getThreadsForAccounts(["a"], "INBOX", 50, 0, []);
    const { sql, params } = lastSelect();
    expect(sql).toContain("tl.label_id IN ($2)");
    expect(params).toEqual(["a", "INBOX", 50, 0]);
  });

  it("numbers the peer parameters after the labels", async () => {
    await getThreadsForAccounts(["a"], ["INBOX", "SENT"], 50, 0, ["me@x.com"]);
    const { sql, params } = lastSelect();
    expect(sql).toContain("NOT IN ($4)");
    expect(sql).toContain("LIMIT $5 OFFSET $6");
    expect(params).toEqual(["a", "INBOX", "SENT", "me@x.com", 50, 0]);
  });

  it("falls back to no label filter when given none", async () => {
    await getThreadsForAccounts(["a"], undefined, 50, 0, []);
    expect(lastSelect().sql).not.toContain("tl.label_id");
  });
});

describe("threads service - manual merge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockResolvedValue(mockDb as unknown as Awaited<ReturnType<typeof getDb>>);
    mockDb.select.mockResolvedValue([]);
  });

  it("points the sources at the target without rewriting anything", async () => {
    await mergeThreads("acc-1", "t-target", ["t-a", "t-b"]);
    const [sql, params] = mockDb.execute.mock.calls[0]!;
    expect(sql).toContain("SET merged_into = $2, merged_by = $3");
    expect(sql).toContain("id IN ($4, $5)");
    expect(params).toEqual(["acc-1", "t-target", "manual", "t-a", "t-b"]);
  });

  it("re-points anything already merged into a source, so no chain forms", async () => {
    await mergeThreads("acc-1", "t-target", ["t-a"]);
    const [sql] = mockDb.execute.mock.calls[1]!;
    expect(sql).toContain("WHERE account_id = $1 AND merged_into IN ($4)");
  });

  it("never merges a thread into itself", async () => {
    await mergeThreads("acc-1", "t-target", ["t-target"]);
    expect(mockDb.execute).not.toHaveBeenCalled();
  });

  it("records which rule merged, so a wrong rule can be undone alone", async () => {
    await mergeThreads("acc-1", "t-target", ["t-a"], "subject");
    expect(mockDb.execute.mock.calls[0]![1]).toEqual(["acc-1", "t-target", "subject", "t-a"]);
  });

  it("separates one thread and leaves the others merged", async () => {
    await unmergeThread("acc-1", "t-a");
    expect(mockDb.execute).toHaveBeenCalledWith(
      "UPDATE threads SET merged_into = NULL, merged_by = NULL WHERE account_id = $1 AND id = $2",
      ["acc-1", "t-a"],
    );
  });

  it("reads back what was folded into a thread", async () => {
    mockDb.select.mockResolvedValue([{ id: "t-a" }, { id: "t-b" }]);
    expect(await getMergedThreadIds("acc-1", "t-target")).toEqual(["t-a", "t-b"]);
  });

  it("keeps a merged-away thread out of the lists", async () => {
    await getThreadsForAccounts(["a"], "INBOX", 50, 0, []);
    expect(mockDb.select.mock.calls.at(-1)![0]).toContain("t.merged_into IS NULL");
  });
});
