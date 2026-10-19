import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/ai/providerManager", () => ({ isAiAvailable: vi.fn(async () => true) }));
vi.mock("@/services/ai/aiService", () => ({ summarizeThread: vi.fn(async () => "A generated summary") }));
vi.mock("@/services/db/aiCache", () => ({
  getAiCache: vi.fn(async () => null),
  deleteAiCache: vi.fn(async () => undefined),
}));
vi.mock("@/stores/toastStore", () => ({ reportError: vi.fn() }));
vi.mock("@/router/navigate", () => ({ navigateToSettings: vi.fn() }));

import { renderHook, act, waitFor } from "@testing-library/react";
import { useThreadSummary, SUMMARIZE_THREAD_EVENT } from "./useThreadSummary";
import { isAiAvailable } from "@/services/ai/providerManager";
import { summarizeThread } from "@/services/ai/aiService";
import { deleteAiCache, getAiCache } from "@/services/db/aiCache";
import { reportError } from "@/stores/toastStore";
import type { DbMessage } from "@/services/db/messages";

const messages = [{ id: "m1" }, { id: "m2" }] as unknown as DbMessage[];

function renderSummary(overrides: Partial<{ messages: DbMessage[]; accountId: string | null }> = {}) {
  return renderHook(() =>
    useThreadSummary({
      threadId: "t1",
      accountId: "acc1",
      messages: overrides.messages ?? messages,
      ...overrides,
    }),
  );
}

describe("useThreadSummary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isAiAvailable).mockResolvedValue(true);
    vi.mocked(getAiCache).mockResolvedValue(null);
    vi.mocked(summarizeThread).mockResolvedValue("A generated summary");
  });

  it("does not summarize just because the thread has several messages", async () => {
    const { result } = renderSummary();

    await waitFor(() => expect(result.current.canRequest).toBe(true));

    expect(summarizeThread).not.toHaveBeenCalled();
    expect(result.current.summary).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it("shows a cached summary immediately, without calling the model", async () => {
    vi.mocked(getAiCache).mockResolvedValue("Ever so slightly stale");

    const { result } = renderSummary();

    await waitFor(() => expect(result.current.summary).toBe("Ever so slightly stale"));
    expect(getAiCache).toHaveBeenCalledWith("acc1", "t1", "summary");
    expect(summarizeThread).not.toHaveBeenCalled();
  });

  it("generates only when requested", async () => {
    const { result } = renderSummary();
    await waitFor(() => expect(result.current.canRequest).toBe(true));

    await act(async () => result.current.request());

    expect(summarizeThread).toHaveBeenCalledTimes(1);
    expect(summarizeThread).toHaveBeenCalledWith("t1", "acc1", messages);
    expect(result.current.summary).toBe("A generated summary");
    expect(result.current.loading).toBe(false);
  });

  it("answers the shortcut event the same way as the button", async () => {
    const { result } = renderSummary();
    await waitFor(() => expect(result.current.canRequest).toBe(true));

    await act(async () => {
      window.dispatchEvent(new Event(SUMMARIZE_THREAD_EVENT));
    });

    await waitFor(() => expect(result.current.summary).toBe("A generated summary"));
  });

  it("reuses what it already has instead of paying for the same summary twice", async () => {
    const { result } = renderSummary();
    await waitFor(() => expect(result.current.canRequest).toBe(true));

    await act(async () => result.current.request());
    await act(async () => result.current.request());

    expect(summarizeThread).toHaveBeenCalledTimes(1);
    expect(result.current.collapsed).toBe(false);
  });

  it("drops the cached row before regenerating on refresh", async () => {
    vi.mocked(getAiCache).mockResolvedValue("Old summary");
    const { result } = renderSummary();
    await waitFor(() => expect(result.current.summary).toBe("Old summary"));

    await act(async () => result.current.refresh());

    expect(deleteAiCache).toHaveBeenCalledWith("acc1", "t1", "summary");
    expect(summarizeThread).toHaveBeenCalledTimes(1);
    expect(result.current.summary).toBe("A generated summary");
  });

  it("says why a request cannot be served rather than failing silently", async () => {
    vi.mocked(isAiAvailable).mockResolvedValue(false);
    const { result } = renderSummary();
    await waitFor(() => expect(isAiAvailable).toHaveBeenCalled());

    await act(async () => result.current.request());

    expect(result.current.canRequest).toBe(false);
    expect(summarizeThread).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      "Summaries need an AI provider",
      undefined,
      expect.objectContaining({ label: "Open AI settings" }),
    );
  });

  it("reports a provider failure on the toast, not the console", async () => {
    vi.mocked(summarizeThread).mockRejectedValue(new Error("rate limited"));
    const { result } = renderSummary();
    await waitFor(() => expect(result.current.canRequest).toBe(true));

    await act(async () => result.current.request());

    expect(reportError).toHaveBeenCalledWith(
      "Could not summarize this conversation",
      expect.any(Error),
      expect.objectContaining({ label: "Open AI settings" }),
    );
    expect(result.current.loading).toBe(false);
  });

  it("offers nothing for a single-message thread", async () => {
    const single = [messages[0]!] as unknown as DbMessage[];
    const { result } = renderSummary({ messages: single });

    await waitFor(() => expect(isAiAvailable).toHaveBeenCalled());
    expect(result.current.canRequest).toBe(false);
  });
});
