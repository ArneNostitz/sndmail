import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  status: { phase: "ready" as string | null, error: null as string | null, account_id: null as string | null, updated_at: 1 },
  pendingResyncs: 0,
  pendingSyncs: 0,
  accountPhase: "syncing" as string,
  accountError: null as string | null,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string) => {
    if (command === "worker_wake") {
      state.status = { phase: "syncing", error: null, account_id: "account-1", updated_at: 2 };
    }
  }),
}));

vi.mock("@/services/db/connection", () => ({
  getDb: vi.fn(async () => ({
    select: vi.fn(async (query: string) => {
      if (query.includes("worker_mail_status")) return [{ ...state.status }];
      if (query.includes("worker_resync_requests")) return [{ count: state.pendingResyncs }];
      if (query.includes("worker_sync_requests")) return [{ count: state.pendingSyncs }];
      if (query.includes("worker_mail_account_status")) return [{ account_id: "account-1", phase: state.accountPhase, error: state.accountError }];
      return [];
    }),
    execute: vi.fn(async (query: string) => {
      if (query.includes("INSERT OR IGNORE INTO worker_resync_requests")) state.pendingResyncs = 1;
      if (query.includes("INSERT OR IGNORE INTO worker_sync_requests")) state.pendingSyncs = 1;
    }),
  })),
}));

vi.mock("@/services/db/settings", () => ({ getSetting: vi.fn() }));
vi.mock("@/stores/toastStore", () => ({ notify: vi.fn(), reportError: vi.fn() }));
vi.mock("@/stores/uiStore", () => ({ useUIStore: { getState: vi.fn(() => ({ setSyncState: vi.fn() })) } }));
vi.mock("./postprocess", () => ({ drainWorkerPostprocessQueue: vi.fn() }));

import { requestWorkerResync, wakeBackgroundWorkerAndWait } from "./workerClient";

describe("background worker sync waiting", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    state.status = { phase: "ready", error: null, account_id: null, updated_at: 1 };
    state.pendingResyncs = 0;
    state.pendingSyncs = 0;
    state.accountPhase = "syncing";
    state.accountError = null;
  });

  afterEach(() => vi.useRealTimers());

  it("waits for the helper to report the requested account as complete", async () => {
    const finished = wakeBackgroundWorkerAndWait(["account-1"]);
    await vi.advanceTimersByTimeAsync(500);
    state.status = { phase: "ready", error: null, account_id: null, updated_at: 3 };
    state.accountPhase = "ready";
    state.pendingSyncs = 0;
    await vi.advanceTimersByTimeAsync(500);
    await expect(finished).resolves.toBeUndefined();
  });

  it("keeps a full resync pending until the helper removes its durable request", async () => {
    const finished = requestWorkerResync(["account-1"]);
    await vi.advanceTimersByTimeAsync(500);
    state.status = { phase: "ready", error: null, account_id: null, updated_at: 3 };
    await vi.advanceTimersByTimeAsync(1_000);
    state.pendingResyncs = 0;
    await vi.advanceTimersByTimeAsync(500);
    await expect(finished).resolves.toBeUndefined();
  });

  it("surfaces a helper-reported failure", async () => {
    const finished = wakeBackgroundWorkerAndWait(["account-1"]);
    const rejection = expect(finished).rejects.toThrow("mailbox unavailable");
    await vi.advanceTimersByTimeAsync(500);
    state.status = { phase: "error", error: "mailbox unavailable", account_id: null, updated_at: 3 };
    state.accountPhase = "error";
    state.accountError = "mailbox unavailable";
    state.pendingSyncs = 0;
    await vi.advanceTimersByTimeAsync(500);
    await rejection;
  });
});
