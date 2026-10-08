import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/services/db/sendAsAliases", () => ({
  upsertAlias: vi.fn(() => Promise.resolve("mock-id")),
}));

import { upsertAlias } from "@/services/db/sendAsAliases";
import { createSendAsAlias, deleteSendAsAlias, fetchSendAsAliases } from "./sendAs";

describe("fetchSendAsAliases", () => {
  const mockClient = {
    request: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
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
});

describe("createSendAsAlias", () => {
  const mockClient = {
    request: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.request.mockResolvedValue({ sendAs: [] });
  });

  it("posts the alias and re-syncs the stored list", async () => {
    await createSendAsAlias(mockClient as never, "acc-1", "hello@reimedy.com", "Reimedy");

    expect(mockClient.request).toHaveBeenNthCalledWith(1, "/settings/sendAs", {
      method: "POST",
      body: JSON.stringify({
        sendAsEmail: "hello@reimedy.com",
        treatAsAlias: true,
        displayName: "Reimedy",
      }),
    });
    expect(mockClient.request).toHaveBeenNthCalledWith(2, "/settings/sendAs");
  });

  it("omits displayName when not provided", async () => {
    await createSendAsAlias(mockClient as never, "acc-1", "hello@reimedy.com");

    expect(mockClient.request).toHaveBeenNthCalledWith(1, "/settings/sendAs", {
      method: "POST",
      body: JSON.stringify({
        sendAsEmail: "hello@reimedy.com",
        treatAsAlias: true,
      }),
    });
  });

  it("rethrows 403 with a reauthorize message", async () => {
    mockClient.request.mockRejectedValue(
      new Error("Gmail API error: 403 insufficient permissions"),
    );

    await expect(
      createSendAsAlias(mockClient as never, "acc-1", "hello@reimedy.com"),
    ).rejects.toThrow(/not authorized to change your send-as addresses/);
  });
});

describe("deleteSendAsAlias", () => {
  const mockClient = {
    request: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.request.mockResolvedValue({ sendAs: [] });
  });

  it("deletes the URL-encoded alias and re-syncs the stored list", async () => {
    await deleteSendAsAlias(mockClient as never, "acc-1", "hello@reimedy.com");

    expect(mockClient.request).toHaveBeenNthCalledWith(
      1,
      "/settings/sendAs/hello%40reimedy.com",
      { method: "DELETE" },
    );
    expect(mockClient.request).toHaveBeenNthCalledWith(2, "/settings/sendAs");
  });

  it("rethrows 403 with a reauthorize message", async () => {
    mockClient.request.mockRejectedValue(
      new Error("Gmail API error: 403 insufficient permissions"),
    );

    await expect(
      deleteSendAsAlias(mockClient as never, "acc-1", "hello@reimedy.com"),
    ).rejects.toThrow(/not authorized to change your send-as addresses/);
  });
});
