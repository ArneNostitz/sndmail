// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { beforeEach, afterAll, vi } from "vitest";

const db = new DatabaseSync(":memory:");

vi.mock("@/services/db/connection", () => ({
  getDb: async () => ({
    select: async <T>(sql: string, params: unknown[] = []) => {
      const named = Object.fromEntries(params.map((value, index) => [`$${index + 1}`, value]));
      return db.prepare(sql).all(named as never) as T;
    },
  }),
}));

import { collectOwnAddresses } from "@/services/accounts/ownAddresses";
import {
  getThreadsForAccounts,
  getThreadsForCategoryAcrossAccounts,
} from "./threads";

const schema = `
  CREATE TABLE threads (
    id TEXT, account_id TEXT, subject TEXT, snippet TEXT, last_message_at INTEGER,
    message_count INTEGER, is_read INTEGER, is_starred INTEGER, is_important INTEGER,
    has_attachments INTEGER, is_snoozed INTEGER, snooze_until INTEGER,
    is_pinned INTEGER DEFAULT 0, is_muted INTEGER DEFAULT 0, merged_into TEXT,
    PRIMARY KEY (account_id, id)
  );
  CREATE TABLE messages (
    id TEXT, account_id TEXT, thread_id TEXT, from_name TEXT,
    from_address TEXT, snippet TEXT, date INTEGER, is_read_receipt INTEGER DEFAULT 0
    , PRIMARY KEY (account_id, id)
  );
  CREATE TABLE thread_labels (account_id TEXT, thread_id TEXT, label_id TEXT);
  CREATE TABLE thread_categories (account_id TEXT, thread_id TEXT, category TEXT);
  CREATE TABLE accounts (id TEXT PRIMARY KEY, email TEXT);
  CREATE TABLE send_as_aliases (
    id TEXT, account_id TEXT, email TEXT, display_name TEXT, reply_to_address TEXT,
    signature_id TEXT, is_primary INTEGER, is_default INTEGER, treat_as_alias INTEGER,
    verification_status TEXT, created_at INTEGER
  );
`;

beforeEach(() => {
  db.exec("DROP TABLE IF EXISTS thread_categories; DROP TABLE IF EXISTS thread_labels; DROP TABLE IF EXISTS messages; DROP TABLE IF EXISTS threads; DROP TABLE IF EXISTS send_as_aliases; DROP TABLE IF EXISTS accounts;");
  db.exec(schema);
});

afterAll(() => db.close());

function addThread(account: string, id: string, lastAt: number, label = "INBOX") {
  db.prepare(`INSERT INTO threads (id, account_id, subject, snippet, last_message_at, message_count, is_read, is_starred, is_important, has_attachments)
    VALUES (?, ?, ?, ?, ?, 1, 0, 0, 0, 0)`).run(id, account, id, `thread preview ${id}`, lastAt);
  db.prepare("INSERT INTO thread_labels (account_id, thread_id, label_id) VALUES (?, ?, ?)").run(account, id, label);
}

function addMessage(account: string, thread: string, id: string, from: string, at: number, snippet: string | null, receipt = 0) {
  db.prepare(`INSERT INTO messages (id, account_id, thread_id, from_name, from_address, snippet, date, is_read_receipt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, account, thread, from.split("@")[0] ?? from, from, snippet, at, receipt);
}

describe("real SQLite unified inbox projection", () => {
  it("uses mailbox and verified alias as own addresses; reply does not change peer preview or inbox position", async () => {
    db.prepare("INSERT INTO accounts VALUES (?, ?)").run("a", "own@company.test");
    db.prepare(`INSERT INTO send_as_aliases (id, account_id, email, is_primary, is_default, treat_as_alias, verification_status, created_at)
      VALUES (?, ?, ?, 0, 0, 1, 'accepted', 1)`).run("alias", "a", "reply@alt.test");
    const own = await collectOwnAddresses([{ id: "a", email: " Own@Company.Test " } as never, { id: "b", email: "other@company.test" } as never], ["a"]);
    expect(own.sort()).toEqual(["own@company.test", "reply@alt.test"]);

    addThread("a", "replied", 300);
    db.prepare("UPDATE threads SET last_message_at = 100 WHERE account_id = 'a' AND id = 'replied'").run();
    addMessage("a", "replied", "r1", "peer@external.test", 100, "original incoming preview");
    addThread("a", "recent", 200);
    addMessage("a", "recent", "r3", "newer@external.test", 200, "newer unrelated");
    const beforeSend = await getThreadsForAccounts(["a"], "INBOX", 50, 0, own);
    const beforeOrder = beforeSend.map((row) => row.id);
    expect(beforeOrder).toEqual(["recent", "replied"]);
    expect(beforeSend.find((row) => row.id === "replied")).toMatchObject({
      peer_address: "peer@external.test",
      peer_snippet: "original incoming preview",
      peer_message_at: 100,
      inbox_message_at: 100,
    });

    addMessage("a", "replied", "r2", "reply@alt.test", 300, "sent reply preview");
    db.prepare("INSERT INTO thread_labels (account_id, thread_id, label_id) VALUES ('a', 'replied', 'SENT')").run();
    db.prepare("UPDATE threads SET last_message_at = 300 WHERE account_id = 'a' AND id = 'replied'").run();
    const reloadedOwn = await collectOwnAddresses([{ id: "a", email: " Own@Company.Test " } as never, { id: "b", email: "other@company.test" } as never], ["a"]);
    expect(reloadedOwn.sort()).toEqual(["own@company.test", "reply@alt.test"]);
    expect(reloadedOwn).not.toContain("peer@external.test");

    const rows = await getThreadsForAccounts(["a"], ["INBOX", "SENT"], 50, 0, reloadedOwn);
    expect(rows.map((row) => row.id)).toEqual(["replied", "recent"]);
    expect(rows).toHaveLength(beforeSend.length);
    expect(rows.find((row) => row.id === "replied")).toMatchObject({
      from_address: "reply@alt.test",
      snippet: "thread preview replied",
      peer_address: "peer@external.test",
      peer_snippet: "original incoming preview",
      peer_message_at: 100,
    });
    // The INBOX-only view continues using the incoming message as its timestamp.
    const inboxRows = await getThreadsForAccounts(["a"], "INBOX", 50, 0, reloadedOwn);
    expect(inboxRows.map((row) => row.id)).toEqual(beforeOrder);
    expect(inboxRows).toHaveLength(beforeSend.length);
    expect(inboxRows.find((row) => row.id === "replied")?.inbox_message_at).toBe(100);
    // Combined INBOX/SENT view sorts on thread activity and has no inbox-only projection.
    expect(rows[1]?.inbox_message_at).toBeUndefined();
    const sentRows = await getThreadsForAccounts(["a"], "SENT", 50, 0, reloadedOwn);
    expect(sentRows.map((row) => row.id)).toEqual(["replied"]);
    expect(sentRows[0]?.inbox_message_at).toBeUndefined();
  });

  it("keeps equal-date peer fields from one deterministic message", async () => {
    addThread("a", "tie", 50);
    addMessage("a", "tie", "peer-z", "z@external.test", 50, "z snippet");
    addMessage("a", "tie", "peer-a", "a@external.test", 50, "a snippet");
    const [row] = await getThreadsForAccounts(["a"], "INBOX", 50, 0, ["own@company.test"]);
    expect(row).toMatchObject({ peer_address: "z@external.test", peer_snippet: "z snippet", peer_message_at: 50 });
  });

  it("scopes duplicate thread IDs by account and retains an own-only thread with INBOX membership", async () => {
    addThread("a", "shared", 40);
    addMessage("a", "shared", "shared-message-id", "a-peer@external.test", 40, "account a");
    addThread("b", "shared", 90);
    addMessage("b", "shared", "shared-message-id", "b-peer@external.test", 90, "account b");
    addThread("a", "without-label", 60, "INBOX");
    addMessage("a", "without-label", "only-own", "own@company.test", 60, "own only");
    addThread("a", "incoming-only", 70, "INBOX");
    addMessage("a", "incoming-only", "incoming-only-message", "incoming@external.test", 70, "incoming only");

    const rows = await getThreadsForAccounts(["a", "b"], "INBOX", 50, 0, ["own@company.test"]);
    expect(rows.map((row) => [row.account_id, row.id])).toEqual([["b", "shared"], ["a", "incoming-only"], ["a", "without-label"], ["a", "shared"]]);
    expect(rows[0]?.peer_address).toBe("b-peer@external.test");
    expect(rows[3]?.peer_address).toBe("a-peer@external.test");
    expect(rows[1]).toMatchObject({ peer_address: "incoming@external.test", inbox_message_at: 70 });
    expect(rows[2]).toMatchObject({ peer_address: null, inbox_message_at: 60 });
  });

  it("applies non-Primary category membership while projecting peer and inbox date", async () => {
    addThread("a", "promotional", 30);
    addMessage("a", "promotional", "promo-peer", "promo@external.test", 25, "promo preview");
    db.prepare("INSERT INTO thread_categories (account_id, thread_id, category) VALUES ('a', 'promotional', 'Promotions')").run();
    const rows = await getThreadsForCategoryAcrossAccounts(["a"], "Promotions", 50, 0, ["own@company.test"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ peer_snippet: "promo preview", peer_message_at: 25, inbox_message_at: 25 });
  });

  it("does not use the sent snippet when the incoming peer snippet is null", async () => {
    addThread("a", "null-peer-snippet", 20);
    addMessage("a", "null-peer-snippet", "incoming", "peer@external.test", 10, null);
    addMessage("a", "null-peer-snippet", "sent", "own@company.test", 20, "sent preview");
    const [row] = await getThreadsForAccounts(["a"], "INBOX", 50, 0, ["own@company.test"]);
    expect(row?.peer_snippet).toBeNull();
  });

  it("does not let a later read receipt displace the incoming peer", async () => {
    addThread("a", "receipt", 30);
    addMessage("a", "receipt", "incoming", "peer@external.test", 10, "peer preview");
    addMessage("a", "receipt", "receipt", "receipt@external.test", 30, "receipt preview", 1);
    const [row] = await getThreadsForAccounts(["a"], "INBOX", 50, 0, ["own@company.test"]);
    expect(row).toMatchObject({ peer_address: "peer@external.test", peer_message_at: 10, inbox_message_at: 10 });
  });

  it("projects peer preview and inbox date in category inbox queries too", async () => {
    addThread("a", "category", 20);
    addMessage("a", "category", "incoming", "peer@external.test", 10, "category peer");
    const [row] = await getThreadsForCategoryAcrossAccounts(["a"], "Primary", 50, 0, ["own@company.test"]);
    expect(row).toMatchObject({ peer_snippet: "category peer", peer_message_at: 10, inbox_message_at: 10 });
  });
});
