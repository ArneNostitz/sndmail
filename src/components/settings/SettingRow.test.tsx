import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { SettingRow } from "./SettingRow";

describe("SettingRow", () => {
  it("pairs the label with the control it changes", () => {
    render(
      <SettingRow label="Theme">
        <button>System</button>
      </SettingRow>,
    );

    expect(screen.getByText("Theme")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "System" })).toBeInTheDocument();
  });
});
