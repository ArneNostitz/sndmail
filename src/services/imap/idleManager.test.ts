import { describe, it, expect, vi, beforeEach } from "vitest";

const mockInvoke = vi.fn(() => Promise.resolve());
const listeners = new Map<string, (event: { payload: unknown }) => void>();
const mockListen = vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
  listeners.set(name, handler);
  return Promise.resolve(() => listeners.delete(name));
});
const settings = new Map<string, string>();
let accounts: Record<string, unknown>[] = [];

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => mockInvoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, handler: (event: { payload: unknown }) => void) => mockListen(name, handler),
}));
vi.mock("@/services/db/settings", () => ({
  getSetting: (k: string) => Promise.resolve(settings.get(k) ?? null),
}));
vi.mock("@/services/db/accounts", () => ({ getAllAccounts: () => Promise.resolve(accounts) }));
vi.mock("@/services/oauth/oauthTokenManager", () => ({
  ensureFreshToken: () => Promise.resolve("tok-123"),
}));
vi.mock("./imapConfigBuilder", () => ({
  buildImapConfig: () => ({ host: "imap.example.com", port: 993 }),
}));

import { startIdleWatchers, stopIdleWatchers, accountsWithoutIdle, reconnectAccount } from "./idleManager";

const gmail = { id: "g1", email: "a@gmail.com", provider: "gmail_api", auth_method: "oauth2", is_active: 1 };
const imap = { id: "i1", email: "b@host.tld", provider: "imap", auth_method: "password", is_active: 1, imap_host: "imap.host.tld" };

describe("startIdleWatchers", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    settings.clear();
    accounts = [];
    await stopIdleWatchers();
    vi.clearAllMocks();
  });

  it("points a Gmail account at Gmail's IMAP endpoint with its token", async () => {
    accounts = [gmail];
    await startIdleWatchers();
    expect(mockInvoke).toHaveBeenCalledWith("imap_start_idle", {
      accountId: "g1",
      config: expect.objectContaining({
        host: "imap.gmail.com",
        // The Rust side accepts "tls" — "ssl" was refused on every attempt
        security: "tls",
        auth_method: "oauth2",
        password: "tok-123",
      }),
    });
  });

  it("uses the account's own server for an IMAP account", async () => {
    accounts = [imap];
    await startIdleWatchers();
    expect(mockInvoke).toHaveBeenCalledWith("imap_start_idle", {
      accountId: "i1",
      config: expect.objectContaining({ host: "imap.example.com" }),
    });
  });

  it("does nothing at all when the setting is off", async () => {
    settings.set("imap_idle", "false");
    accounts = [gmail];
    await startIdleWatchers();
    expect(mockInvoke).not.toHaveBeenCalledWith("imap_start_idle", expect.anything());
  });

  it("skips a disabled account", async () => {
    accounts = [{ ...gmail, is_active: 0 }];
    await startIdleWatchers();
    expect(mockInvoke).not.toHaveBeenCalledWith("imap_start_idle", expect.anything());
  });

  it("keeps going when one account refuses, and remembers which", async () => {
    // The scope-less Gmail account: IMAP rejects the token, polling carries on
    mockInvoke.mockImplementationOnce(() => Promise.reject(new Error("AUTHENTICATIONFAILED")));
    accounts = [gmail, imap];
    await startIdleWatchers();
    expect(accountsWithoutIdle().has("g1")).toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith("imap_start_idle", {
      accountId: "i1",
      config: expect.anything(),
    });
  });

  it("stops every watcher on request", async () => {
    await stopIdleWatchers();
    expect(mockInvoke).toHaveBeenCalledWith("imap_stop_all_idle");
  });
});

import { useIdleStatusStore } from "@/stores/idleStatusStore";

describe("startIdleWatchers - what it tells the status store", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    settings.clear();
    accounts = [];
    await stopIdleWatchers();
    vi.clearAllMocks();
  });

  it("marks an account connecting once the watcher is asked for", async () => {
    accounts = [gmail];
    await startIdleWatchers();
    expect(useIdleStatusStore.getState().statuses.g1).toBe("connecting");
  });

  it("keeps a refused account on 'connecting' while a retry is pending", async () => {
    // The refusal is usually an expired access token, and the retry mints a
    // new one — saying "failed" before trying again would be a lie
    mockInvoke.mockImplementationOnce(() => Promise.reject(new Error("AUTHENTICATIONFAILED")));
    accounts = [gmail];
    await startIdleWatchers();
    expect(useIdleStatusStore.getState().statuses.g1).toBe("connecting");
  });

  it("marks an account off when it cannot idle at all", async () => {
    accounts = [{ ...imap, imap_host: null }];
    await startIdleWatchers();
    expect(useIdleStatusStore.getState().statuses.i1).toBe("off");
  });

  it("forgets everything when the watchers stop", async () => {
    accounts = [gmail];
    await startIdleWatchers();
    await stopIdleWatchers();
    expect(useIdleStatusStore.getState().statuses).toEqual({});
  });
});

describe("recovering from a stopped watcher", () => {
  beforeEach(async () => {
    vi.useRealTimers();
    vi.clearAllMocks();
    settings.clear();
    accounts = [];
    await stopIdleWatchers();
    vi.clearAllMocks();
  });

  it("reconnects with a freshly minted token after Rust gives up", async () => {
    // Rust ends its loop on AUTHENTICATIONFAILED, which is what an expired
    // OAuth token looks like — recovery has to start on this side
    vi.useFakeTimers();
    accounts = [gmail];
    await startIdleWatchers();
    mockInvoke.mockClear();

    listeners.get("snd-idle-failed")?.({
      payload: { account_id: "g1", error: "AUTHENTICATIONFAILED" },
    });
    await vi.advanceTimersByTimeAsync(0); // the account lookup
    expect(mockInvoke).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(mockInvoke).toHaveBeenCalledWith("imap_start_idle", {
      accountId: "g1",
      config: expect.objectContaining({ password: "tok-123" }),
    });
    vi.useRealTimers();
  });

  it("gives up and says so once the retries are spent", async () => {
    vi.useFakeTimers();
    mockInvoke.mockImplementation(() => Promise.reject(new Error("AUTHENTICATIONFAILED")));
    accounts = [gmail];
    await startIdleWatchers();

    // 5s + 30s + 2min + 10min of retries, all refused
    await vi.advanceTimersByTimeAsync(13 * 60_000);
    expect(useIdleStatusStore.getState().statuses.g1).toBe("failed");
    expect(useIdleStatusStore.getState().reasons.g1).toContain("AUTHENTICATIONFAILED");
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(() => Promise.resolve());
    vi.useRealTimers();
  });

  it("stops retrying once the watcher reports itself connected", async () => {
    vi.useFakeTimers();
    mockInvoke.mockImplementationOnce(() => Promise.reject(new Error("AUTHENTICATIONFAILED")));
    accounts = [gmail];
    await startIdleWatchers();
    mockInvoke.mockClear();

    listeners.get("snd-idle-status")?.({
      payload: { account_id: "g1", state: "connected" },
    });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(useIdleStatusStore.getState().statuses.g1).toBe("connected");
    expect(mockInvoke).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe("reconnectAccount", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    settings.clear();
    accounts = [];
    await stopIdleWatchers();
    vi.clearAllMocks();
  });

  it("restarts only the account that was asked for", async () => {
    accounts = [gmail, imap];
    await reconnectAccount("i1");
    const starts = mockInvoke.mock.calls.filter(([cmd]) => cmd === "imap_start_idle");
    expect(starts).toHaveLength(1);
    expect(starts[0]![1]).toEqual(expect.objectContaining({ accountId: "i1" }));
  });

  it("does nothing for an account it does not know", async () => {
    accounts = [gmail];
    await reconnectAccount("nope");
    expect(mockInvoke).not.toHaveBeenCalledWith("imap_start_idle", expect.anything());
  });
});
