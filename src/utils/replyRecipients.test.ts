import { describe, expect, it } from "vitest";
import { latestIncomingMessage, resolveReplyRecipients } from "./replyRecipients";

const own = ["me@workspace.com", "me@other-domain.com"];

describe("reply recipients", () => {
  it("targets the latest correspondent when the newest message is from a send-as identity", () => {
    const incoming = { from_address: "peer@example.com", reply_to: "replies@example.com" };
    const sent = { from_address: "me@other-domain.com", to_addresses: "peer@example.com" };
    const target = latestIncomingMessage([incoming, sent], own)!;

    expect(target).toBe(incoming);
    expect(resolveReplyRecipients(target, "reply", own)).toEqual({
      to: ["replies@example.com"],
      cc: [],
    });
  });

  it("keeps Reply All participants and removes all own aliases", () => {
    expect(resolveReplyRecipients({
      from_address: "Peer <peer@example.com>",
      to_addresses: '"Me, Work" <me@workspace.com>, teammate@example.com',
      cc_addresses: "me@other-domain.com, copy@example.com",
    }, "replyAll", own)).toEqual({
      to: ["peer@example.com", "teammate@example.com"],
      cc: ["copy@example.com"],
    });
  });

  it("supports a thread with no incoming message by returning no target", () => {
    expect(latestIncomingMessage([
      { from_address: "me@workspace.com" },
      { from_address: "me@other-domain.com" },
    ], own)).toBeUndefined();
  });
});
