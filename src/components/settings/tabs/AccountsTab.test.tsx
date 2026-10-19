import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => false) }));
vi.mock("@/services/db/settings", () => ({
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  getSecureSetting: vi.fn(async () => null),
  setSecureSetting: vi.fn(async () => {}),
}));
vi.mock("../AccountDetail", () => ({
  PROVIDER_LABELS: { gmail_api: "Gmail", imap: "IMAP", caldav: "CalDAV" },
  AccountDetail: ({ account, onBack }: { account: { id: string }; onBack: () => void }) => (
    <div>
      <span>detail:{account.id}</span>
      <button onClick={onBack}>back to accounts</button>
    </div>
  ),
}));
vi.mock("../GmailPushRelaySection", () => ({
  GmailPushRelaySection: () => <div>gmail push relay</div>,
}));
vi.mock("../SyncOfflineSection", () => ({
  SyncOfflineSection: () => <div>sync and offline</div>,
}));

import { useAccountStore } from "@/stores/accountStore";
import { useUIStore } from "@/stores/uiStore";
import { AccountsTab } from "./AccountsTab";

const account = {
  id: "gmail-1",
  email: "me@example.com",
  displayName: "Me",
  avatarUrl: null,
  isActive: true,
  provider: "gmail_api",
};

describe("AccountsTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUIStore.setState({ settingsAddAccountPending: false });
    useAccountStore.setState({ accounts: [account] });
  });

  it("opens one account's settings and comes back to the list", async () => {
    render(<AccountsTab />);

    fireEvent.click(await screen.findByRole("button", { name: /me@example.com/ }));
    expect(screen.getByText("detail:gmail-1")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "back to accounts" }));
    await waitFor(() => expect(screen.queryByText("detail:gmail-1")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: /me@example.com/ })).toBeInTheDocument();
  });

  it("keeps the list-level settings on the list", () => {
    render(<AccountsTab />);

    expect(screen.getByText("Gmail")).toBeInTheDocument();
    expect(screen.getByText("Instant delivery")).toBeInTheDocument();
    expect(screen.getByText("Google API")).toBeInTheDocument();
    expect(screen.getByText("gmail push relay")).toBeInTheDocument();
    expect(screen.getByText("sync and offline")).toBeInTheDocument();
  });

  it("answers a request to add an account from outside settings", async () => {
    useUIStore.setState({ settingsAddAccountPending: true });
    render(<AccountsTab />);

    await waitFor(() => expect(useUIStore.getState().settingsAddAccountPending).toBe(false));
    expect(await screen.findByText("Add Account")).toBeInTheDocument();
  });
});
