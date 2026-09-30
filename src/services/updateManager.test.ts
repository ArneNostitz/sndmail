import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCheck = vi.fn();
vi.mock("@tauri-apps/plugin-updater", () => ({ check: (...args: unknown[]) => mockCheck(...args) }));

import {
  UPDATE_SOURCE_CONFIGURED,
  checkForUpdateNow,
  getAvailableUpdate,
  installUpdate,
  startUpdateChecker,
  _resetForTesting,
} from "./updateManager";

beforeEach(() => {
  _resetForTesting();
  mockCheck.mockReset();
});

describe("updateManager without a release source", () => {
  it("does not call the updater in the background", () => {
    expect(UPDATE_SOURCE_CONFIGURED).toBe(false);
    startUpdateChecker();
    expect(mockCheck).not.toHaveBeenCalled();
    expect(getAvailableUpdate()).toBeNull();
  });

  it("reports manual checks as unavailable rather than up to date", async () => {
    await expect(checkForUpdateNow()).rejects.toThrow("update source is not configured");
    expect(mockCheck).not.toHaveBeenCalled();
    await expect(installUpdate()).rejects.toThrow("No update available");
  });
});
