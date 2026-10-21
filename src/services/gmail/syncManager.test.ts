import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock all dependencies before importing the module under test
vi.mock("./tokenManager", () => ({
  getGmailClient: vi.fn(),
}));
vi.mock("./sync", () => ({
  initialSync: vi.fn(),
  deltaSync: vi.fn(),
}));
vi.mock("../db/accounts", () => ({
  getAccount: vi.fn(),
  clearAccountHistoryId: vi.fn(),
}));
vi.mock("../db/settings", () => ({
  getSetting: vi.fn().mockResolvedValue("365"),
}));
vi.mock("../db/threads", () => ({
  getThreadCountForAccount: vi.fn(),
  deleteAllThreadsForAccount: vi.fn(),
}));
vi.mock("../db/messages", () => ({
  deleteAllMessagesForAccount: vi.fn(),
}));
vi.mock("../imap/imapSync", () => ({
  imapInitialSync: vi.fn(),
  imapDeltaSync: vi.fn(),
}));
vi.mock("../db/folderSyncState", () => ({
  clearAllFolderSyncStates: vi.fn(),
}));
vi.mock("../oauth/oauthTokenManager", () => ({
  ensureFreshToken: vi.fn(),
}));
vi.mock("../calendar/providerFactory", () => ({
  hasCalendarSupport: vi.fn().mockResolvedValue(false),
  getCalendarProvider: vi.fn(),
}));
vi.mock("../db/calendars", () => ({
  getVisibleCalendars: vi.fn().mockResolvedValue([]),
  upsertCalendar: vi.fn(),
  updateCalendarSyncToken: vi.fn(),
}));
vi.mock("../db/calendarEvents", () => ({
  upsertCalendarEvent: vi.fn(),
  deleteEventByRemoteId: vi.fn(),
}));
vi.mock("../worker/workerClient", () => ({
  backgroundWorkerOwnsSync: vi.fn(() => false),
  wakeBackgroundWorkerAndWait: vi.fn(),
  requestWorkerResync: vi.fn(),
}));

// Import after mocks
import {
  syncAccount,
  startInitialSync,
  triggerSync,
  forceFullSync,
  resyncAccount,
  onSyncStatus,
  onSyncBatchComplete,
} from "./syncManager";
import { getAccount, clearAccountHistoryId } from "../db/accounts";
import { getGmailClient } from "./tokenManager";
import { initialSync, deltaSync } from "./sync";
import { deleteAllThreadsForAccount } from "../db/threads";
import { deleteAllMessagesForAccount } from "../db/messages";
import {
  backgroundWorkerOwnsSync,
  wakeBackgroundWorkerAndWait,
  requestWorkerResync,
} from "../worker/workerClient";

const mockGetAccount = vi.mocked(getAccount);
const mockGetGmailClient = vi.mocked(getGmailClient);
const mockInitialSync = vi.mocked(initialSync);
const mockDeltaSync = vi.mocked(deltaSync);
const mockWorkerOwnsSync = vi.mocked(backgroundWorkerOwnsSync);
const mockWakeWorkerAndWait = vi.mocked(wakeBackgroundWorkerAndWait);
const mockRequestWorkerResync = vi.mocked(requestWorkerResync);
const mockClearHistoryId = vi.mocked(clearAccountHistoryId);
const mockDeleteThreads = vi.mocked(deleteAllThreadsForAccount);
const mockDeleteMessages = vi.mocked(deleteAllMessagesForAccount);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeGmailAccount(id: string, historyId: string | null = null) {
  return {
    id,
    email: `${id}@gmail.com`,
    display_name: id,
    avatar_url: null,
    is_active: 1,
    provider: "gmail_api" as const,
    history_id: historyId,
    refresh_token: "tok",
    access_token: "tok",
    token_expiry: Date.now() + 60_000,
    client_id: "cid",
    client_secret: null,
    created_at: new Date().toISOString(),
    imap_host: null,
    imap_port: null,
    imap_security: null,
    smtp_host: null,
    smtp_port: null,
    smtp_security: null,
    auth_method: null,
    imap_password: null,
    imap_username: null,
  };
}

describe("syncManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetGmailClient.mockResolvedValue(
      {} as ReturnType<typeof getGmailClient> extends Promise<infer T>
        ? T
        : never,
    );
    mockInitialSync.mockResolvedValue();
    mockDeltaSync.mockResolvedValue();
    mockWorkerOwnsSync.mockReturnValue(false);
    mockWakeWorkerAndWait.mockResolvedValue();
    mockRequestWorkerResync.mockResolvedValue();
  });

  describe("syncAccount", () => {
    it("runs initial sync for an account without history_id", async () => {
      mockGetAccount.mockResolvedValue(makeGmailAccount("a1"));

      await syncAccount("a1");

      expect(mockInitialSync).toHaveBeenCalledTimes(1);
      expect(mockDeltaSync).not.toHaveBeenCalled();
    });

    it("runs delta sync for an account with history_id", async () => {
      mockGetAccount.mockResolvedValue(makeGmailAccount("a1", "12345"));

      await syncAccount("a1");

      expect(mockDeltaSync).toHaveBeenCalledTimes(1);
      expect(mockInitialSync).not.toHaveBeenCalled();
    });

    it("queues a second account while sync is in progress", async () => {
      const a1 = makeGmailAccount("a1", "100");
      const a2 = makeGmailAccount("a2", "200");

      mockGetAccount.mockImplementation(async (id: string) => {
        if (id === "a1") return a1;
        if (id === "a2") return a2;
        return null;
      });

      // Make first sync slow
      const barrier = new Promise<void>((r) => {
        // Resolve after 50ms
        setTimeout(r, 50);
      });
      let firstCall = true;
      mockDeltaSync.mockImplementation(() => {
        if (firstCall) {
          firstCall = false;
          return barrier;
        }
        return Promise.resolve();
      });

      const first = syncAccount("a1");
      // a2 will be queued since a1 is in progress
      const second = syncAccount("a2");

      await first;
      await second;

      // Both accounts synced (a1 directly, a2 via queue drain)
      expect(mockDeltaSync).toHaveBeenCalledTimes(2);
    });
  });

  describe("startInitialSync", () => {
    it("triggers one immediate sync", async () => {
      mockGetAccount.mockResolvedValue(makeGmailAccount("a1", "100"));

      startInitialSync(["a1"]);

      // Wait for async sync chain to complete
      await wait(50);

      expect(mockDeltaSync).toHaveBeenCalledTimes(1);
    });

    it("does not install a periodic polling timer", async () => {
      mockGetAccount.mockResolvedValue(makeGmailAccount("a1", "100"));
      const intervalSpy = vi.spyOn(globalThis, "setInterval");

      startInitialSync(["a1"]);
      await wait(50);

      expect(intervalSpy).not.toHaveBeenCalled();
      intervalSpy.mockRestore();
    });
  });

  describe("triggerSync", () => {
    it("syncs all provided accounts", async () => {
      const a1 = makeGmailAccount("a1", "100");
      const a2 = makeGmailAccount("a2", "200");

      mockGetAccount.mockImplementation(async (id: string) => {
        if (id === "a1") return a1;
        if (id === "a2") return a2;
        return null;
      });

      await triggerSync(["a1", "a2"]);

      expect(mockDeltaSync).toHaveBeenCalledTimes(2);
    });

    it("publishes one completion for the whole account batch", async () => {
      mockGetAccount.mockImplementation(async (id: string) =>
        makeGmailAccount(id, "100"),
      );
      const completions: string[][] = [];
      const unsub = onSyncBatchComplete(({ accountIds }) => {
        completions.push(accountIds);
      });

      await triggerSync(["a1", "a2", "a3"]);
      unsub();

      expect(completions).toEqual([["a1", "a2", "a3"]]);
    });
  });

  describe("single ingestion owner", () => {
    beforeEach(() => {
      mockWorkerOwnsSync.mockReturnValue(true);
      mockGetAccount.mockResolvedValue(makeGmailAccount("a1", "100"));
    });

    it("forwards a UI sync request to the helper instead of syncing here", async () => {
      await syncAccount("a1");
      await triggerSync(["a1", "a2"]);

      expect(mockWakeWorkerAndWait).toHaveBeenNthCalledWith(1, ["a1"]);
      expect(mockWakeWorkerAndWait).toHaveBeenNthCalledWith(2, ["a1", "a2"]);
      // The TypeScript engines must not run beside the worker.
      expect(mockInitialSync).not.toHaveBeenCalled();
      expect(mockDeltaSync).not.toHaveBeenCalled();
    });

    it("forwards the startup catch-up without starting a second loop", async () => {
      startInitialSync(["a1"]);
      await wait(10);

      expect(mockWakeWorkerAndWait).toHaveBeenCalledWith(["a1"]);
      expect(mockDeltaSync).not.toHaveBeenCalled();
    });

    it("asks the worker for a full resync rather than deleting rows under it", async () => {
      await forceFullSync(["a1"]);
      await resyncAccount("a1");

      expect(mockRequestWorkerResync).toHaveBeenNthCalledWith(1, ["a1"]);
      expect(mockRequestWorkerResync).toHaveBeenNthCalledWith(2, ["a1"]);
      expect(mockClearHistoryId).not.toHaveBeenCalled();
      expect(mockDeleteThreads).not.toHaveBeenCalled();
      expect(mockDeleteMessages).not.toHaveBeenCalled();
      expect(mockDeltaSync).not.toHaveBeenCalled();
    });
  });

  describe("error coercion", () => {
    it("propagates plain string errors from Tauri IPC (not 'Unknown error')", async () => {
      const account = makeGmailAccount("a1", "100");
      mockGetAccount.mockResolvedValue(account);
      // Tauri IPC rejects with a plain string, not an Error instance
      mockDeltaSync.mockRejectedValue("authentication failed for user@test.com");

      const errors: string[] = [];
      const unsub = onSyncStatus((_id, status, _progress, error) => {
        if (status === "error" && error) errors.push(error);
      });

      await syncAccount("a1");
      unsub();

      expect(errors).toHaveLength(1);
      expect(errors[0]).toBe("authentication failed for user@test.com");
      expect(errors[0]).not.toBe("Unknown error");
    });

    it("handles null/undefined errors gracefully", async () => {
      const account = makeGmailAccount("a1", "100");
      mockGetAccount.mockResolvedValue(account);
      mockDeltaSync.mockRejectedValue(null);

      const errors: string[] = [];
      const unsub = onSyncStatus((_id, status, _progress, error) => {
        if (status === "error" && error) errors.push(error);
      });

      await syncAccount("a1");
      unsub();

      expect(errors).toHaveLength(1);
      expect(errors[0]).toBe("Unknown error");
    });
  });
});
