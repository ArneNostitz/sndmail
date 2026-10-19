import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ToggleSwitch } from "./ToggleSwitch";
import { ToggleRow } from "./ToggleRow";

describe("ToggleSwitch", () => {
  it("reports its state and flips on click", () => {
    const onChange = vi.fn();
    render(<ToggleSwitch checked={false} onChange={onChange} label="Reduce motion" />);

    const switchButton = screen.getByRole("switch", { name: "Reduce motion" });
    expect(switchButton).toHaveAttribute("aria-checked", "false");

    fireEvent.click(switchButton);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("does not fire while disabled", () => {
    const onChange = vi.fn();
    render(<ToggleSwitch checked disabled onChange={onChange} label="Inbox is always visible" />);

    fireEvent.click(screen.getByRole("switch", { name: "Inbox is always visible" }));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("ToggleRow", () => {
  it("names the switch after its row label", () => {
    const onToggle = vi.fn();
    render(
      <ToggleRow label="Block remote images" description="Hides tracking pixels" checked onToggle={onToggle} />,
    );

    expect(screen.getByText("Hides tracking pixels")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "Block remote images" }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
