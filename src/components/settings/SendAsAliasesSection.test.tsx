import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/services/db/sendAsAliases", () => ({
  getAliasesForAccount: vi.fn(async () => []),
  mapDbAlias: vi.fn((alias) => alias),
  setDefaultAlias: vi.fn(),
}));
vi.mock("@/services/gmail/tokenManager", () => ({ getGmailClient: vi.fn(async () => ({})) }));
vi.mock("@/services/gmail/sendAs", () => ({ fetchSendAsAliases: vi.fn() }));

import { useAccountStore } from "@/stores/accountStore";
import { fetchSendAsAliases } from "@/services/gmail/sendAs";
import { getGmailClient } from "@/services/gmail/tokenManager";
import { getAliasesForAccount } from "@/services/db/sendAsAliases";
import { SendAsAliasesSection } from "./SettingsPage";

describe("SendAsAliasesSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAccountStore.setState({
      accounts: [{ id: "gmail-1", email: "user@example.com", displayName: "User", avatarUrl: null, isActive: true, provider: "gmail_api" }],
    });
  });

  it("guides Gmail users to add aliases in Google and refreshes Gmail's list", async () => {
    render(<SendAsAliasesSection />);
    expect(screen.getByText(/Google Admin as an alternate email address/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh aliases" }));
    await waitFor(() => expect(fetchSendAsAliases).toHaveBeenCalledWith({}, "gmail-1"));
    expect(getGmailClient).toHaveBeenCalledWith("gmail-1");
    expect(getAliasesForAccount).toHaveBeenCalledWith("gmail-1");
  });

  it("does not offer Gmail alias refresh for other providers", () => {
    useAccountStore.setState({
      accounts: [{ id: "imap-1", email: "user@example.com", displayName: "User", avatarUrl: null, isActive: true, provider: "imap" }],
    });
    render(<SendAsAliasesSection />);
    expect(screen.queryByRole("button", { name: "Refresh aliases" })).not.toBeInTheDocument();
    expect(screen.getByText("Send-as aliases are available for Gmail accounts.")).toBeInTheDocument();
  });
});
