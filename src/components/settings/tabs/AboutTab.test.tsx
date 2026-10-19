import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn(async () => "0.4.21"),
  getTauriVersion: vi.fn(async () => "2.9.0"),
}));
vi.mock("@tauri-apps/plugin-os", () => ({
  platform: vi.fn(() => "macos"),
  arch: vi.fn(() => "aarch64"),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => {}) }));

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AboutTab } from "./AboutTab";

describe("AboutTab", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reports the running version", async () => {
    render(<AboutTab />);

    await waitFor(() => expect(screen.getByText(/Version 0\.4\.21/)).toBeInTheDocument());
    expect(screen.getByText("Tauri version")).toBeInTheDocument();
  });

  it("opens the repository in the browser", async () => {
    render(<AboutTab />);

    fireEvent.click(screen.getByRole("button", { name: /GitHub Repository/ }));

    await waitFor(() =>
      expect(openUrl).toHaveBeenCalledWith("https://github.com/ArneNostitz/sndmail"),
    );
  });

  it("opens the WebView inspector", async () => {
    render(<AboutTab />);

    fireEvent.click(screen.getByRole("button", { name: "Open DevTools" }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("open_devtools"));
  });
});
