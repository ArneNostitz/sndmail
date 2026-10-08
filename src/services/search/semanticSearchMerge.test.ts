import type { SemanticHit } from "./semanticSearchRuntime";
import {
  mergeSemanticHits,
  semanticHitPassesScope,
  type SemanticMergeScope,
} from "./semanticSearchMerge";
import type { SearchMatch } from "@/stores/threadStore";

function hit(overrides: Partial<SemanticHit> = {}): SemanticHit {
  return {
    id: "doc-1",
    title: "A subject",
    metadata: {
      account: "acct-1",
      threadId: "t1",
      messageId: "m1",
    },
    tags: ["acct-1", "INBOX"],
    ...overrides,
  };
}

describe("semanticHitPassesScope", () => {
  it("accepts everything without scope restrictions", () => {
    expect(semanticHitPassesScope(hit(), {})).toBe(true);
  });

  it("rejects hits from other accounts", () => {
    const scope: SemanticMergeScope = { accountIds: ["acct-1"] };
    expect(semanticHitPassesScope(hit(), scope)).toBe(true);
    expect(
      semanticHitPassesScope(
        hit({ metadata: { account: "acct-2", threadId: "t1", messageId: "m1" } }),
        scope,
      ),
    ).toBe(false);
  });

  it("matches label scope by id or name, case-insensitively", () => {
    const scope: SemanticMergeScope = {
      labelIds: ["Label_123"],
      labels: [{ id: "Label_123", name: "Receipts" }],
    };
    expect(semanticHitPassesScope(hit({ tags: ["acct-1", "receipts"] }), scope)).toBe(true);
    expect(semanticHitPassesScope(hit({ tags: ["acct-1", "label_123"] }), scope)).toBe(true);
    expect(semanticHitPassesScope(hit({ tags: ["acct-1", "TRASH"] }), scope)).toBe(false);
  });

  it("is inclusive for labels it cannot resolve", () => {
    const scope: SemanticMergeScope = { labelIds: ["UNHEARD_OF"] };
    expect(semanticHitPassesScope(hit({ tags: ["unheard_of"] }), scope)).toBe(true);
  });

  it("drops spam and trash hits unless the scope explicitly includes them", () => {
    const excluding: SemanticMergeScope = { excludeSpamTrash: true };
    expect(semanticHitPassesScope(hit({ tags: ["SPAM"] }), excluding)).toBe(false);
    expect(semanticHitPassesScope(hit({ tags: ["Trash"] }), excluding)).toBe(false);
    expect(semanticHitPassesScope(hit(), excluding)).toBe(true);
    expect(
      semanticHitPassesScope(hit({ tags: ["SPAM"] }), { excludeSpamTrash: false }),
    ).toBe(true);
  });
});

describe("mergeSemanticHits", () => {
  it("adds new threads with a semantic excerpt", () => {
    const matches = new Map<string, SearchMatch>();
    const added = mergeSemanticHits(
      [
        hit({
          snippet: "  the   passage about invoices ",
          semanticEvidence: { passage: "cleaner passage", titleContext: null, distance: 0.2 },
        }),
      ],
      matches,
      {},
    );
    expect(added).toBe(1);
    expect(matches.get("t1")).toEqual({
      messageIds: new Set(["m1"]),
      excerpt: "cleaner passage",
    });
  });

  it("falls back to the snippet when there is no passage", () => {
    const matches = new Map<string, SearchMatch>();
    mergeSemanticHits([hit({ snippet: "snippet text" })], matches, {});
    expect(matches.get("t1")?.excerpt).toBe("snippet text");
  });

  it("keeps keyword excerpts and message ids for threads both engines found", () => {
    const matches = new Map<string, SearchMatch>([
      ["t1", { messageIds: new Set(["m-fts"]), excerpt: "keyword excerpt" }],
    ]);
    const added = mergeSemanticHits(
      [
        hit({
          snippet: "semantic excerpt",
          metadata: { account: "a", threadId: "t1", messageId: "m-sem" },
        }),
      ],
      matches,
      {},
    );
    expect(added).toBe(0);
    expect(matches.get("t1")).toEqual({
      messageIds: new Set(["m-fts", "m-sem"]),
      excerpt: "keyword excerpt",
    });
  });

  it("fills in a missing keyword excerpt from the semantic hit", () => {
    const matches = new Map<string, SearchMatch>([
      ["t1", { messageIds: new Set(["m-fts"]), excerpt: null }],
    ]);
    mergeSemanticHits([hit({ snippet: "semantic excerpt" })], matches, {});
    expect(matches.get("t1")?.excerpt).toBe("semantic excerpt");
  });

  it("skips hits outside the requested scope and without a thread", () => {
    const matches = new Map<string, SearchMatch>();
    mergeSemanticHits(
      [
        hit({ metadata: { account: "other", threadId: "t9", messageId: "m9" } }),
        hit({ tags: ["SPAM"] }),
        hit({ metadata: {} }),
      ],
      matches,
      { accountIds: ["acct-1"], excludeSpamTrash: true },
    );
    expect(matches.size).toBe(0);
  });
});
