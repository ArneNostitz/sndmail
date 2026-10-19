import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string) =>
    command === "worker_create_relay_profile" ? "relay-token" : undefined,
  ),
}));

import { invoke } from "@tauri-apps/api/core";
import { useAccountStore } from "@/stores/accountStore";
import { PluginsTab } from "./PluginsTab";

describe("PluginsTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAccountStore.setState({
      accounts: [
        { id: "gmail-1", email: "me@example.com", displayName: "Me", avatarUrl: null, isActive: true, provider: "gmail_api" },
      ],
    });
  });

  it("grants access only to the mailboxes picked, and shows the token once", async () => {
    render(<PluginsTab />);

    const create = screen.getByRole("button", { name: "Create access token" });
    expect(create).toBeDisabled();

    fireEvent.click(screen.getByRole("checkbox", { name: "Share me@example.com with Commonplace" }));
    fireEvent.click(create);

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("worker_create_relay_profile", {
        profileId: "commonplace",
        accountIds: ["gmail-1"],
        readContent: false,
      }),
    );
    expect(await screen.findByLabelText("Commonplace mail relay access token")).toHaveValue("relay-token");
  });

  it("revokes the grant", async () => {
    render(<PluginsTab />);

    fireEvent.click(screen.getByRole("button", { name: "Revoke access" }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("worker_revoke_relay_profile", { profileId: "commonplace" }),
    );
  });
});
