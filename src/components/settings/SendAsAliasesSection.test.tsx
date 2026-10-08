import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/services/db/sendAsAliases", () => ({
  getAliasesForAccount: vi.fn(async () => []),
  mapDbAlias: vi.fn((alias) => alias),
  setDefaultAlias: vi.fn(),
  upsertAlias: vi.fn(async () => "alias-id"),
  deleteAlias: vi.fn(async () => {}),
}));
vi.mock("@/services/gmail/tokenManager", () => ({ getGmailClient: vi.fn(async () => ({})) }));
vi.mock("@/services/gmail/sendAs", () => ({
  fetchSendAsAliases: vi.fn(),
  createSendAsAlias: vi.fn(async () => {}),
  deleteSendAsAlias: vi.fn(async () => {}),
}));
vi.mock("@/services/accounts/ownAddresses", () => ({
  collectOwnAddresses: vi.fn(async (_accounts, accountIds) =>
    accountIds.map((id: string) => `${id}@example.com`)),
}));
vi.mock("@/services/accounts/aliasSuggestions", () => ({
  findAliasSuggestions: vi.fn(async () => []),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => {}) }));

import { useAccountStore } from "@/stores/accountStore";
import { fetchSendAsAliases, createSendAsAlias } from "@/services/gmail/sendAs";
import { getGmailClient } from "@/services/gmail/tokenManager";
import { getAliasesForAccount, upsertAlias } from "@/services/db/sendAsAliases";
import { findAliasSuggestions } from "@/services/accounts/aliasSuggestions";
import { SendAsAliasesSection } from "./SettingsPage";

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
    render(<SendAsAliasesSection />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh aliases" }));
    await waitFor(() => expect(fetchSendAsAliases).toHaveBeenCalledWith({}, "gmail-1"));
    expect(getGmailClient).toHaveBeenCalledWith("gmail-1");
    expect(getAliasesForAccount).toHaveBeenCalledWith("gmail-1");
  });

  it("adds a Gmail alias through the Gmail API", async () => {
    render(<SendAsAliasesSection />);
    fireEvent.change(screen.getByLabelText("New alias address"), {
      target: { value: "hello@reimedy.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add alias" }));
    await waitFor(() =>
      expect(createSendAsAlias).toHaveBeenCalledWith({}, "gmail-1", "hello@reimedy.com"),
    );
    expect(upsertAlias).not.toHaveBeenCalled();
  });

  it("rejects an incomplete address", async () => {
    render(<SendAsAliasesSection />);
    fireEvent.change(screen.getByLabelText("New alias address"), {
      target: { value: "not-an-address" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add alias" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Enter a full email address"),
    );
    expect(createSendAsAlias).not.toHaveBeenCalled();
  });

  it("offers and adds suggested aliases from received mail", async () => {
    vi.mocked(findAliasSuggestions).mockResolvedValue([
      { email: "hello@reimedy.com", occurrences: 4, lastSeen: 100 },
    ]);
    render(<SendAsAliasesSection />);
    await screen.findByText("hello@reimedy.com");
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(createSendAsAlias).toHaveBeenCalledWith({}, "gmail-1", "hello@reimedy.com"),
    );
  });

  it("adds IMAP aliases locally without the Gmail API", async () => {
    useAccountStore.setState({
      accounts: [{ ...baseAccount, id: "imap-1", provider: "imap" }],
    });
    render(<SendAsAliasesSection />);
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
    expect(createSendAsAlias).not.toHaveBeenCalled();
  });

  it("shows no alias management for non-mail accounts", () => {
    useAccountStore.setState({
      accounts: [{ ...baseAccount, id: "cal-1", provider: "caldav" }],
    });
    render(<SendAsAliasesSection />);
    expect(
      screen.getByText("Send-as aliases are available for mail accounts."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add alias" })).not.toBeInTheDocument();
  });
});
