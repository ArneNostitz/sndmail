import {
  getAllAccounts,
  getAccount,
  getAccountByEmail,
  insertImapAccount,
  insertOAuthImapAccount,
  insertAccount,
  deleteAccount,
  updateAccountTokens,
  updateAccountSyncState,
} from "./accounts";
import { createMockGmailAccount, createMockImapAccount } from "@/test/mocks";

const mockExecute = vi.fn();
const mockSelect = vi.fn();
const mockInvoke = vi.fn(() => Promise.resolve(undefined));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock("./connection", () => ({
  getDb: vi.fn(() => ({
    execute: (...args: unknown[]) => mockExecute(...args),
    select: (...args: unknown[]) => mockSelect(...args),
  })),
  selectFirstBy: vi.fn(),
}));

vi.mock("@/utils/crypto", () => ({
  encryptValue: vi.fn((val: string) => Promise.resolve(`enc:${val}`)),
  decryptValue: vi.fn((val: string) => Promise.resolve(val.replace("enc:", ""))),
  isEncrypted: vi.fn((val: string) => val.startsWith("enc:")),
}));

import { selectFirstBy } from "./connection";

const mockSelectFirstBy = vi.mocked(selectFirstBy);

describe("accounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getAccount", () => {
    it("returns null for non-existent account", async () => {
      mockSelectFirstBy.mockResolvedValue(null);

      const result = await getAccount("nonexistent");

      expect(result).toBeNull();
    });

    it("returns a Gmail account with decrypted tokens", async () => {
      mockSelectFirstBy.mockResolvedValue(createMockGmailAccount());

      const result = await getAccount("acc-gmail");

      expect(result).not.toBeNull();
      expect(result!.id).toBe("acc-gmail");
      expect(result!.provider).toBe("gmail_api");
      expect(result!.access_token).toBe("access-token");
      expect(result!.refresh_token).toBe("refresh-token");
    });

    it("returns an IMAP account with decrypted imap_password", async () => {
      mockSelectFirstBy.mockResolvedValue(createMockImapAccount());

      const result = await getAccount("acc-imap");

      expect(result).not.toBeNull();
      expect(result!.provider).toBe("imap");
      expect(result!.imap_host).toBe("imap.example.com");
      expect(result!.imap_port).toBe(993);
      expect(result!.imap_security).toBe("tls");
      expect(result!.smtp_host).toBe("smtp.example.com");
      expect(result!.smtp_port).toBe(465);
      expect(result!.smtp_security).toBe("tls");
      expect(result!.auth_method).toBe("password");
      expect(result!.imap_password).toBe("secret-password");
    });

    it("handles IMAP account with null imap_password gracefully", async () => {
      mockSelectFirstBy.mockResolvedValue(
        createMockImapAccount({ imap_password: null }),
      );

      const result = await getAccount("acc-imap");

      expect(result!.imap_password).toBeNull();
    });
  });

  describe("getAccountByEmail", () => {
    it("returns account matching email", async () => {
      mockSelectFirstBy.mockResolvedValue(createMockImapAccount());

      const result = await getAccountByEmail("user@example.com");

      expect(result).not.toBeNull();
      expect(result!.email).toBe("user@example.com");
    });

    it("returns null when email not found", async () => {
      mockSelectFirstBy.mockResolvedValue(null);

      const result = await getAccountByEmail("unknown@example.com");

      expect(result).toBeNull();
    });
  });

  describe("getAllAccounts", () => {
    it("returns all accounts with decrypted tokens", async () => {
      mockSelect.mockResolvedValue([createMockGmailAccount(), createMockImapAccount()]);

      const result = await getAllAccounts();

      expect(result).toHaveLength(2);
      expect(result[0]!.provider).toBe("gmail_api");
      expect(result[0]!.access_token).toBe("access-token");
      expect(result[1]!.provider).toBe("imap");
      expect(result[1]!.imap_password).toBe("secret-password");
    });

    it("returns empty array when no accounts exist", async () => {
      mockSelect.mockResolvedValue([]);

      const result = await getAllAccounts();

      expect(result).toEqual([]);
    });

    it("decrypts imap_password for IMAP accounts in the list", async () => {
      mockSelect.mockResolvedValue([createMockImapAccount()]);

      const result = await getAllAccounts();

      expect(result[0]!.imap_password).toBe("secret-password");
    });
  });

  describe("insertImapAccount", () => {
    it("creates the mailbox through the backend IPC command", async () => {
      await insertImapAccount({
        id: "new-imap",
        email: "user@fastmail.com",
        displayName: "Fastmail User",
        avatarUrl: null,
        imapHost: "imap.fastmail.com",
        imapPort: 993,
        imapSecurity: "ssl",
        smtpHost: "smtp.fastmail.com",
        smtpPort: 465,
        smtpSecurity: "ssl",
        authMethod: "password",
        password: "my-app-password",
      });

      // One writer: the backend validates, encrypts and inserts. The frontend
      // must not touch the accounts table itself.
      expect(mockExecute).not.toHaveBeenCalled();
      expect(mockInvoke).toHaveBeenCalledTimes(1);
      expect(mockInvoke).toHaveBeenCalledWith("account_add_imap", {
        account: {
          id: "new-imap",
          email: "user@fastmail.com",
          display_name: "Fastmail User",
          avatar_url: null,
          imap_host: "imap.fastmail.com",
          imap_port: 993,
          imap_security: "ssl",
          smtp_host: "smtp.fastmail.com",
          smtp_port: 465,
          smtp_security: "ssl",
          auth_method: "password",
          password: "my-app-password",
          imap_username: null,
          accept_invalid_certs: false,
        },
      });
    });

    it("passes a custom login username and certificate override through", async () => {
      await insertImapAccount({
        id: "new-imap-2",
        email: "user@example.com",
        displayName: null,
        avatarUrl: null,
        imapHost: "imap.example.com",
        imapPort: 993,
        imapSecurity: "ssl",
        smtpHost: "smtp.example.com",
        smtpPort: 465,
        smtpSecurity: "starttls",
        authMethod: "password",
        password: "pass",
        imapUsername: "custom-login-id",
        acceptInvalidCerts: true,
      });

      const [, args] = mockInvoke.mock.calls[0] as [string, { account: Record<string, unknown> }];
      expect(args.account.imap_username).toBe("custom-login-id");
      expect(args.account.accept_invalid_certs).toBe(true);
      expect(args.account.smtp_security).toBe("starttls");
    });

    it("surfaces a backend rejection to the caller", async () => {
      mockInvoke.mockRejectedValueOnce("Email address is not valid");

      await expect(
        insertImapAccount({
          id: "bad",
          email: "not-an-address",
          displayName: null,
          avatarUrl: null,
          imapHost: "imap.example.com",
          imapPort: 993,
          imapSecurity: "ssl",
          smtpHost: "smtp.example.com",
          smtpPort: 465,
          smtpSecurity: "ssl",
          authMethod: "password",
          password: "pass",
        }),
      ).rejects.toBe("Email address is not valid");
    });
  });

  describe("insertOAuthImapAccount", () => {
    it("sends OAuth credentials to the backend instead of encrypting them here", async () => {
      await insertOAuthImapAccount({
        id: "imap-oauth",
        email: "user@example.com",
        displayName: null,
        avatarUrl: null,
        imapHost: "imap.example.com",
        imapPort: 993,
        imapSecurity: "ssl",
        smtpHost: "smtp.example.com",
        smtpPort: 465,
        smtpSecurity: "ssl",
        accessToken: "access",
        refreshToken: "refresh",
        tokenExpiresAt: 1_700_000_000,
        oauthProvider: "google",
        oauthClientId: "client-id",
        oauthClientSecret: null,
      });

      expect(mockExecute).not.toHaveBeenCalled();
      const [, args] = mockInvoke.mock.calls[0] as [string, { account: Record<string, unknown> }];
      expect(args.account.auth_method).toBe("oauth2");
      expect(args.account.access_token).toBe("access");
      expect(args.account.refresh_token).toBe("refresh");
      expect(args.account.token_expires_at).toBe(1_700_000_000);
      expect(args.account.oauth_provider).toBe("google");
      expect(args.account.password).toBeUndefined();
    });
  });

  describe("insertAccount (Gmail/OAuth)", () => {
    it("inserts OAuth account with encrypted tokens", async () => {
      mockExecute.mockResolvedValue(undefined);

      await insertAccount({
        id: "gmail-1",
        email: "user@gmail.com",
        displayName: "Test User",
        avatarUrl: "https://example.com/avatar.jpg",
        accessToken: "access-token-123",
        refreshToken: "refresh-token-456",
        tokenExpiresAt: 9999999999,
      });

      expect(mockExecute).toHaveBeenCalledTimes(1);
      const [sql, params] = mockExecute.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("INSERT INTO accounts");
      expect(params).toContain("enc:access-token-123");
      expect(params).toContain("enc:refresh-token-456");
    });
  });

  describe("deleteAccount", () => {
    it("deletes account by id", async () => {
      mockExecute.mockResolvedValue(undefined);

      await deleteAccount("acc-1");

      const [sql, params] = mockExecute.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("DELETE FROM accounts");
      expect(params).toEqual(["acc-1"]);
    });
  });

  describe("updateAccountTokens", () => {
    it("updates access_token with encryption", async () => {
      mockExecute.mockResolvedValue(undefined);

      await updateAccountTokens("acc-1", "new-token", 1234567890);

      const [sql, params] = mockExecute.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("UPDATE accounts SET access_token");
      expect(params).toContain("enc:new-token");
      expect(params).toContain(1234567890);
    });
  });

  describe("updateAccountSyncState", () => {
    it("updates history_id and last_sync_at", async () => {
      mockExecute.mockResolvedValue(undefined);

      await updateAccountSyncState("acc-1", "history-999");

      const [sql, params] = mockExecute.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("UPDATE accounts SET history_id");
      expect(params).toEqual(["history-999", "acc-1"]);
    });
  });
});
