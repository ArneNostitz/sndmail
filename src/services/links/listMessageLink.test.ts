import { describe, expect, it } from "vitest";
import type { DbMessage } from "@/services/db/messages";
import { createListMessageLink } from "./listMessageLink";
import { parseMailLink } from "@/utils/mailLink";

function message(id: string, date: number, from: string | null, overrides: Partial<DbMessage> = {}): DbMessage {
  return {
    id, date, from_address: from, account_id: "a", thread_id: "t", is_read_receipt: 0,
    from_name: null, to_addresses: null, cc_addresses: null, bcc_addresses: null, reply_to: null,
    subject: null, snippet: null, is_read: 0, is_starred: 0, body_html: null, body_text: null,
    body_cached: 0, raw_size: null, internal_date: null, list_unsubscribe: null,
    list_unsubscribe_post: null, auth_results: null, message_id_header: null,
    references_header: null, in_reply_to_header: null, imap_uid: null, imap_folder: null,
    disposition_notification_to: null, read_receipt_status: null, read_receipt_count: 0,
    read_receipt_last_at: null, ...overrides,
  };
}

describe("createListMessageLink", () => {
  const inbox = [message("incoming", 10, "friend@example.com"), message("outgoing", 20, "me@example.com")];

  it("targets the latest incoming message in Inbox even after an outgoing reply", () => {
    expect(parseMailLink(createListMessageLink(inbox, "a", "t", "inbox", ["me@example.com"])!).messageId).toBe("incoming");
  });

  it("targets the latest message outside Inbox", () => {
    expect(parseMailLink(createListMessageLink(inbox, "a", "t", "sent", ["me@example.com"])!).messageId).toBe("outgoing");
  });

  it("preserves the row account and excludes read receipts", () => {
    const rows = [
      message("mail", 4, "friend@example.com", { account_id: "row-account" }),
      message("receipt", 8, "friend@example.com", { account_id: "row-account", is_read_receipt: 1 }),
    ];
    expect(parseMailLink(createListMessageLink(rows, "row-account", "t", "inbox", [])!)).toEqual({
      accountId: "row-account", threadId: "t", messageId: "mail",
    });
  });

  it("excludes newer alias mail when an external Inbox message exists", () => {
    const url = createListMessageLink([
      message("external", 10, "friend@example.com"),
      message("alias-outgoing", 12, "alias@example.com"),
    ], "a", "t", "inbox", ["alias@example.com"]);
    expect(parseMailLink(url!).messageId).toBe("external");
  });

  it("falls back to the latest real message for own-only Inbox threads", () => {
    const url = createListMessageLink([
      message("own-older", 10, "me@example.com"),
      message("own-latest", 12, "alias@example.com"),
    ], "a", "t", "inbox", ["me@example.com", "alias@example.com"]);
    expect(parseMailLink(url!).messageId).toBe("own-latest");
  });

  it("returns no thread-only fallback when there is no eligible message", () => {
    expect(createListMessageLink([message("receipt", 12, "friend@example.com", { is_read_receipt: 1 })], "a", "t", "inbox", [])).toBeNull();
  });

  it("uses deterministic ID ordering for equal dates", () => {
    const url = createListMessageLink([message("a", 12, "friend@example.com"), message("Z", 12, "friend@example.com")], "a", "t", "inbox", []);
    expect(parseMailLink(url!).messageId).toBe("a");
  });
});
