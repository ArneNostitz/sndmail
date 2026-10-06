import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetAliasesForAccount, mockGetDb, mockSelect } = vi.hoisted(() => ({
  mockGetAliasesForAccount: vi.fn(),
  mockGetDb: vi.fn(),
  mockSelect: vi.fn(),
}));

vi.mock("@/services/db/sendAsAliases", () => ({
  getAliasesForAccount: mockGetAliasesForAccount,
}));

vi.mock("@/services/db/connection", () => ({
  getDb: mockGetDb,
}));

import type { Account } from "@/stores/accountStore";
import { collectOwnAddresses } from "./ownAddresses";

const accounts = [
  { id: "account-1", email: " Owner@Example.com " },
] as Account[];

describe("collectOwnAddresses", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAliasesForAccount.mockResolvedValue([
      { email: " Alias@Example.com " },
    ]);
    // These external correspondents came from messages in threads carrying
    // SENT. The former thread-label fallback incorrectly classified them as
    // user identities.
    mockSelect.mockResolvedValue([
      { from_address: "peer@example.net" },
      { from_address: "another.peer@example.org" },
    ]);
    mockGetDb.mockResolvedValue({ select: mockSelect });
  });

  it("uses only trimmed, lowercase account addresses and explicit aliases", async () => {
    const result = await collectOwnAddresses(accounts, ["account-1"]);

    expect(result).toEqual(["owner@example.com", "alias@example.com"]);
    expect(result).not.toContain("peer@example.net");
    expect(result).not.toContain("another.peer@example.org");
    expect(mockGetDb).not.toHaveBeenCalled();
    expect(mockSelect).not.toHaveBeenCalled();
  });
});
