import { describe, it, expect, vi } from "vitest";
import type { ComponentProps } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { ThreadSummary } from "./ThreadSummary";

function renderSummary(overrides: Partial<ComponentProps<typeof ThreadSummary>> = {}) {
  const props = {
    summary: "Two people agreed on Thursday.",
    loading: false,
    collapsed: false,
    onToggleCollapsed: vi.fn(),
    onRefresh: vi.fn(),
    ...overrides,
  };
  return { ...render(<ThreadSummary {...props} />), props };
}

describe("ThreadSummary", () => {
  it("renders nothing when no summary has been asked for", () => {
    renderSummary({ summary: null });

    expect(screen.queryByText("AI Summary")).not.toBeInTheDocument();
  });

  it("shows the summary it is handed", () => {
    renderSummary();

    expect(screen.getByText("AI Summary")).toBeInTheDocument();
    expect(screen.getByText("Two people agreed on Thursday.")).toBeInTheDocument();
  });

  it("shows progress while one is being generated", () => {
    renderSummary({ summary: null, loading: true });

    expect(screen.getByText("Generating summary...")).toBeInTheDocument();
  });

  it("hides the text when collapsed", () => {
    renderSummary({ collapsed: true });

    expect(screen.queryByText("Two people agreed on Thursday.")).not.toBeInTheDocument();
  });

  it("asks to collapse when the header is clicked", () => {
    const { props } = renderSummary();

    fireEvent.click(screen.getByText("AI Summary"));

    expect(props.onToggleCollapsed).toHaveBeenCalledTimes(1);
  });

  it("regenerates from the refresh control without collapsing the card", () => {
    const { props } = renderSummary();

    fireEvent.click(screen.getByRole("button", { name: "Refresh summary" }));

    expect(props.onRefresh).toHaveBeenCalledTimes(1);
    expect(props.onToggleCollapsed).not.toHaveBeenCalled();
  });
});
