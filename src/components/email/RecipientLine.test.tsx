import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RecipientLine } from "./RecipientLine";

const MANY = Array.from({ length: 250 }, (_, i) => `person${i}@example.com`).join(", ");

describe("RecipientLine", () => {
  it("shows a short list in full", () => {
    render(<RecipientLine toAddresses="a@x.com, b@x.com" />);
    expect(screen.getByText(/To: a@x.com, b@x.com/)).toBeInTheDocument();
    expect(screen.queryByText(/more/)).not.toBeInTheDocument();
  });

  it("folds a long list to one line", () => {
    render(<RecipientLine toAddresses={MANY} />);
    expect(screen.getByText(/\+247 more/)).toBeInTheDocument();
    expect(screen.queryByText(/person200@example.com/)).not.toBeInTheDocument();
  });

  it("opens and closes without touching anything else", () => {
    render(<RecipientLine toAddresses={MANY} />);
    fireEvent.click(screen.getByRole("button", { name: "Show every recipient" }));
    expect(screen.getByText("250 recipients")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Hide the recipient list" }));
    expect(screen.getByText(/\+247 more/)).toBeInTheDocument();
  });

  it("counts Cc towards the total", () => {
    render(<RecipientLine toAddresses="a@x.com, b@x.com" ccAddresses="c@x.com, d@x.com" />);
    fireEvent.click(screen.getByRole("button", { name: "Show every recipient" }));
    expect(screen.getByText("4 recipients")).toBeInTheDocument();
    expect(screen.getByText(/Cc: c@x.com, d@x.com/)).toBeInTheDocument();
  });

  it("renders nothing when there are no recipients", () => {
    const { container } = render(<RecipientLine toAddresses={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("strips display names down to addresses", () => {
    render(<RecipientLine toAddresses={'"Arne Nostitz" <arne@x.com>'} />);
    expect(screen.getByText(/To: arne@x.com/)).toBeInTheDocument();
  });
});

describe("RecipientLine inside a clickable header", () => {
  it("expanding the list does not reach the header's toggle", () => {
    const onHeaderClick = vi.fn();
    render(
      <div onClick={onHeaderClick}>
        <RecipientLine toAddresses={MANY} />
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show every recipient" }));
    expect(screen.getByText("250 recipients")).toBeInTheDocument();
    expect(onHeaderClick).not.toHaveBeenCalled();
  });

  it("collapsing it again does not reach the header either", () => {
    const onHeaderClick = vi.fn();
    render(
      <div onClick={onHeaderClick}>
        <RecipientLine toAddresses={MANY} />
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show every recipient" }));
    fireEvent.click(screen.getByRole("button", { name: "Hide the recipient list" }));
    expect(onHeaderClick).not.toHaveBeenCalled();
  });
});
