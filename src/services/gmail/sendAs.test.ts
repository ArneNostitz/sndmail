import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/services/db/sendAsAliases", () => ({
  upsertAlias: vi.fn(() => Promise.resolve("mock-id")),
  getAliasesForAccount: vi.fn(() => Promise.resolve([])),
  deleteAlias: vi.fn(() => Promise.resolve()),
}));

import { upsertAlias, deleteAlias, getAliasesForAccount } from "@/services/db/sendAsAliases";
import { fetchSendAsAliases } from "./sendAs";

describe("fetchSendAsAliases", () => {
  const mockClient = {
    request: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAliasesForAccount).mockResolvedValue([]);
  });

  it("fetches aliases and upserts each one", async () => {
    mockClient.request.mockResolvedValue({
      sendAs: [
        {
          sendAsEmail: "primary@example.com",
          displayName: "Primary User",
          isPrimary: true,
          treatAsAlias: false,
          verificationStatus: "accepted",
        },
        {
          sendAsEmail: "alias@example.com",
          displayName: "Alias User",
          replyToAddress: "reply@example.com",
          isPrimary: false,
          treatAsAlias: true,
          verificationStatus: "accepted",
        },
      ],
    });

    await fetchSendAsAliases(mockClient as never, "acc-1");

    expect(mockClient.request).toHaveBeenCalledWith("/settings/sendAs");
    expect(upsertAlias).toHaveBeenCalledTimes(2);

    expect(upsertAlias).toHaveBeenCalledWith({
      accountId: "acc-1",
      email: "primary@example.com",
      displayName: "Primary User",
      replyToAddress: null,
      isPrimary: true,
      treatAsAlias: false,
      verificationStatus: "accepted",
    });

    expect(upsertAlias).toHaveBeenCalledWith({
      accountId: "acc-1",
      email: "alias@example.com",
      displayName: "Alias User",
      replyToAddress: "reply@example.com",
      isPrimary: false,
      treatAsAlias: true,
      verificationStatus: "accepted",
    });
  });

  it("handles empty sendAs array gracefully", async () => {
    mockClient.request.mockResolvedValue({ sendAs: [] });

    await fetchSendAsAliases(mockClient as never, "acc-1");

    expect(upsertAlias).not.toHaveBeenCalled();
  });

  it("handles missing sendAs property gracefully", async () => {
    mockClient.request.mockResolvedValue({});

    await fetchSendAsAliases(mockClient as never, "acc-1");

    expect(upsertAlias).not.toHaveBeenCalled();
  });

  it("defaults optional fields", async () => {
    mockClient.request.mockResolvedValue({
      sendAs: [
        {
          sendAsEmail: "minimal@example.com",
        },
      ],
    });

    await fetchSendAsAliases(mockClient as never, "acc-1");

    expect(upsertAlias).toHaveBeenCalledWith({
      accountId: "acc-1",
      email: "minimal@example.com",
      displayName: null,
      replyToAddress: null,
      isPrimary: false,
      treatAsAlias: true,
      verificationStatus: "accepted",
    });
  });

  it("reconciles away local rows no longer on Google", async () => {
    mockClient.request.mockResolvedValue({
      sendAs: [
        {
          sendAsEmail: "primary@example.com",
          isPrimary: true,
        },
      ],
    });
    vi.mocked(getAliasesForAccount).mockResolvedValue([
      { id: "row-1", account_id: "acc-1", email: "removed@example.com" },
      { id: "row-2", account_id: "acc-1", email: "primary@example.com" },
    ] as never);

    await fetchSendAsAliases(mockClient as never, "acc-1");

    expect(deleteAlias).toHaveBeenCalledWith("row-1");
    expect(deleteAlias).not.toHaveBeenCalledWith("row-2");
  });

  it("rethrows 403 with a reauthorize message", async () => {
    mockClient.request.mockRejectedValue(
      new Error("Gmail API error: 403 insufficient permissions"),
    );

    await expect(
      fetchSendAsAliases(mockClient as never, "acc-1"),
    ).rejects.toThrow(/not authorized to read your send-as addresses/);
  });
});
