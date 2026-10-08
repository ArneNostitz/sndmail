import { describe, expect, it } from "vitest";
import { suggestAliasesFromMessageRows } from "./aliasSuggestions";

function row(
  from: string | null,
  to: string | null,
  date: number,
  cc: string | null = null,
) {
  return { from_address: from, to_addresses: to, cc_addresses: cc, date };
}

describe("suggestAliasesFromMessageRows", () => {
  const own = ["hello@diracting.com"];

  it("detects a workspace domain alias by local part", () => {
    const rows = [
      row("someone@example.com", "hello@reimedy.com", 200),
    ];
    expect(suggestAliasesFromMessageRows(rows, own)).toEqual([
      { email: "hello@reimedy.com", occurrences: 1, lastSeen: 200 },
    ]);
  });

  it("does not suggest the account's own address", () => {
    const rows = [
      row("someone@example.com", "hello@diracting.com", 200),
    ];
    expect(suggestAliasesFromMessageRows(rows, own)).toEqual([]);
  });

  it("does not suggest a different local part", () => {
    const rows = [
      row("someone@example.com", "billing@reimedy.com", 200),
    ];
    expect(suggestAliasesFromMessageRows(rows, own)).toEqual([]);
  });

  it("ignores outgoing mail — the user's own From never counts", () => {
    const rows = [
      row("hello@diracting.com", "hello@reimedy.com", 200),
    ];
    expect(suggestAliasesFromMessageRows(rows, own)).toEqual([]);
  });

  it("does not suggest when a similarly-named stranger writes to the own address", () => {
    const rows = [
      row("hello@other-domain.com", "hello@diracting.com", 200),
    ];
    expect(suggestAliasesFromMessageRows(rows, own)).toEqual([]);
  });

  it("reads Cc recipients too", () => {
    const rows = [
      row("someone@example.com", "other@example.com", 200, "hello@reimedy.com"),
    ];
    expect(suggestAliasesFromMessageRows(rows, own)).toEqual([
      { email: "hello@reimedy.com", occurrences: 1, lastSeen: 200 },
    ]);
  });

  it("counts occurrences and keeps the latest date", () => {
    const rows = [
      row("a@example.com", "hello@reimedy.com", 100),
      row("b@example.com", "hello@reimedy.com, other@example.com", 300),
      row("c@example.com", "hello@reimedy.com", 200),
    ];
    expect(suggestAliasesFromMessageRows(rows, own)).toEqual([
      { email: "hello@reimedy.com", occurrences: 3, lastSeen: 300 },
    ]);
  });

  it("normalizes case and parses headers with display names", () => {
    const rows = [
      row("Someone <someone@example.com>", "Reimedy <Hello@Reimedy.com>", 200),
    ];
    expect(suggestAliasesFromMessageRows(rows, own)).toEqual([
      { email: "hello@reimedy.com", occurrences: 1, lastSeen: 200 },
    ]);
  });

  it("already-registered aliases are not suggested again", () => {
    const rows = [
      row("someone@example.com", "hello@reimedy.com", 200),
    ];
    expect(
      suggestAliasesFromMessageRows(rows, ["hello@diracting.com", "hello@reimedy.com"]),
    ).toEqual([]);
  });

  it("sorts by most recently seen and limits to 10", () => {
    const rows = [];
    for (let i = 0; i < 12; i++) {
      rows.push(row(`s${i}@example.com`, `hello@d${i}.com`, i));
    }
    const suggestions = suggestAliasesFromMessageRows(rows, own);
    expect(suggestions).toHaveLength(10);
    expect(suggestions[0]?.email).toBe("hello@d11.com");
    expect(suggestions[9]?.email).toBe("hello@d2.com");
  });

  it("handles missing headers and empty input", () => {
    expect(
      suggestAliasesFromMessageRows(
        [{ from_address: null, to_addresses: null, cc_addresses: null, date: 0 }],
        own,
      ),
    ).toEqual([]);
    expect(suggestAliasesFromMessageRows([], own)).toEqual([]);
  });
});
