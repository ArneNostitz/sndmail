import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/services/db/sendAsAliases", () => ({
  getAliasesForAccount: vi.fn(async () => []),
  getAllAliases: vi.fn(async () => []),
  mapDbAlias: vi.fn((alias) => alias),
  setDefaultAlias: vi.fn(),
  upsertAlias: vi.fn(async () => "alias-id"),
  deleteAlias: vi.fn(async () => {}),
}));
vi.mock("@/services/gmail/tokenManager", () => ({
  getGmailClient: vi.fn(async () => ({})),
  reauthorizeAccount: vi.fn(async () => {}),
}));
vi.mock("@/services/gmail/sendAs", () => ({
  fetchSendAsAliases: vi.fn(),
}));
vi.mock("@/services/accounts/ownAddresses", () => ({
  collectOwnAddresses: vi.fn(async (_accounts, accountIds) =>
    accountIds.map((id: string) => `${id}@example.com`)),
}));
vi.mock("@/services/accounts/aliasSuggestions", () => ({
  findAliasSuggestions: vi.fn(async () => []),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));

import { useAccountStore } from "@/stores/accountStore";
import { fetchSendAsAliases } from "@/services/gmail/sendAs";
import { getGmailClient } from "@/services/gmail/tokenManager";
import {
  getAliasesForAccount,
  upsertAlias,
  deleteAlias,
  getAllAliases,
} from "@/services/db/sendAsAliases";
import { findAliasSuggestions } from "@/services/accounts/aliasSuggestions";
import { reauthorizeAccount } from "@/services/gmail/tokenManager";
import { openUrl } from "@tauri-apps/plugin-opener";
import { SendAsAliasesSection } from "./SendAsAliasesSection";

const baseAccount = {
  id: "gmail-1",
  email: "user@example.com",
  displayName: "User",
  avatarUrl: null,
  isActive: true,
};

describe("SendAsAliasesSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAccountStore.setState({
      accounts: [{ ...baseAccount, provider: "gmail_api" }],
    });
  });

  it("refreshes Gmail's alias list", async () => {
    render(<SendAsAliasesSection accountId="gmail-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh aliases" }));
    await waitFor(() => expect(fetchSendAsAliases).toHaveBeenCalledWith({}, "gmail-1"));
    expect(getGmailClient).toHaveBeenCalledWith("gmail-1");
    expect(getAliasesForAccount).toHaveBeenCalledWith("gmail-1");
  });

  it("does not offer local alias edits for Gmail — manages them Google-side", async () => {
    render(<SendAsAliasesSection accountId="gmail-1" />);
    expect(screen.queryByLabelText("New alias address")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add alias" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Open Gmail settings/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Open Gmail settings/ }));
    await waitFor(() =>
      expect(openUrl).toHaveBeenCalledWith("https://mail.google.com/mail/u/0/#settings/accounts"),
    );
  });

  it("shows Google-side suggestions without an Add action for Gmail", async () => {
    vi.mocked(findAliasSuggestions).mockResolvedValue([
      { email: "hello@reimedy.com", occurrences: 4, lastSeen: 100 },
    ]);
    render(<SendAsAliasesSection accountId="gmail-1" />);
    await screen.findByText("hello@reimedy.com");
    expect(screen.queryByRole("button", { name: "Add" })).not.toBeInTheDocument();
    expect(upsertAlias).not.toHaveBeenCalled();
  });

  it("shows cross-account aliases without a Connect action for Gmail", async () => {
    useAccountStore.setState({
      accounts: [
        { ...baseAccount, provider: "gmail_api" },
        { ...baseAccount, id: "other-1", email: "other@reimedy.com", displayName: "Reimedy", isActive: false },
      ],
    });
    vi.mocked(getAllAliases).mockResolvedValue([
      { id: "a1", account_id: "other-1", email: "hello@reimedy.com", display_name: null, reply_to_address: null, signature_id: null, is_primary: 0, is_default: 0, treat_as_alias: 1, verification_status: "accepted", created_at: 1 },
    ]);
    render(<SendAsAliasesSection accountId="gmail-1" />);
    await screen.findByText("Connected to your other accounts");
    expect(screen.getByText("Also on Reimedy")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect" })).not.toBeInTheDocument();
  });

  it("offers to re-authorize when Gmail refuses send-as access on refresh", async () => {
    vi.mocked(fetchSendAsAliases).mockRejectedValueOnce(
      new Error("sndmail is not authorized to read your send-as addresses. (403)"),
    );
    render(<SendAsAliasesSection accountId="gmail-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh aliases" }));
    await screen.findByRole("button", { name: "Re-authorize" });
    fireEvent.click(screen.getByRole("button", { name: "Re-authorize" }));
    await waitFor(() =>
      expect(reauthorizeAccount).toHaveBeenCalledWith("gmail-1", "user@example.com"),
    );
  });

  it("adds IMAP aliases locally without the Gmail API", async () => {
    useAccountStore.setState({
      accounts: [{ ...baseAccount, id: "imap-1", provider: "imap" }],
    });
    render(<SendAsAliasesSection accountId="imap-1" />);
    expect(screen.queryByRole("button", { name: "Refresh aliases" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("New alias address"), {
      target: { value: "hello@reimedy.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add alias" }));
    await waitFor(() =>
      expect(upsertAlias).toHaveBeenCalledWith({
        accountId: "imap-1",
        email: "hello@reimedy.com",
      }),
    );
  });

  it("does not offer removing aliases for Gmail accounts", async () => {
    vi.mocked(getAliasesForAccount).mockResolvedValue([
      { id: "a1", account_id: "gmail-1", email: "hello@reimedy.com", display_name: null, reply_to_address: null, signature_id: null, is_primary: 0, is_default: 0, treat_as_alias: 1, verification_status: "accepted", created_at: 1 },
    ]);
    render(<SendAsAliasesSection accountId="gmail-1" />);
    await waitFor(() => expect(screen.getAllByText("hello@reimedy.com").length).toBeGreaterThan(0));
    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
    expect(deleteAlias).not.toHaveBeenCalled();
  });

  it("shows no alias management for non-mail accounts", () => {
    useAccountStore.setState({
      accounts: [{ ...baseAccount, id: "cal-1", provider: "caldav" }],
    });
    render(<SendAsAliasesSection accountId="cal-1" />);
    expect(
      screen.getByText("Send-as aliases are available for mail accounts."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add alias" })).not.toBeInTheDocument();
  });
});
