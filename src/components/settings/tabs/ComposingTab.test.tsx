import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const settings: Record<string, string> = {};
vi.mock("@/services/db/settings", () => ({
  getSetting: vi.fn(async (key: string) => settings[key] ?? null),
  setSetting: vi.fn(async (key: string, value: string) => {
    settings[key] = value;
  }),
}));

import { useUIStore } from "@/stores/uiStore";
import { setSetting } from "@/services/db/settings";
import { ComposingTab } from "./ComposingTab";

describe("ComposingTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settings.undo_send_delay_seconds = "5";
    useUIStore.setState({ sendAndArchive: false, defaultReplyMode: "reply" });
  });

  it("persists a changed undo send delay", async () => {
    const { container } = render(<ComposingTab />);
    const undoDelay = container.querySelector("select");

    await waitFor(() => expect(undoDelay).toHaveValue("5"));
    fireEvent.change(undoDelay!, { target: { value: "30" } });

    expect(setSetting).toHaveBeenCalledWith("undo_send_delay_seconds", "30");
  });

  it("flips send and archive in the store", () => {
    render(<ComposingTab />);

    fireEvent.click(screen.getByRole("switch", { name: "Send and archive" }));

    expect(useUIStore.getState().sendAndArchive).toBe(true);
  });

  it("keeps signatures and templates in the composing tab", () => {
    render(<ComposingTab />);

    expect(screen.getByText("Signatures")).toBeInTheDocument();
    expect(screen.getByText("Templates")).toBeInTheDocument();
  });
});
