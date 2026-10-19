import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SelectField } from "./SelectField";

describe("SelectField", () => {
  it("offers every value and reports the picked one", () => {
    const onChange = vi.fn();
    render(
      <SelectField
        value="b"
        ariaLabel="Pick one"
        options={[
          { value: "a", label: "Alpha" },
          { value: "b", label: "Beta" },
        ]}
        onChange={onChange}
      />,
    );

    const select = screen.getByLabelText("Pick one");
    expect(select).toHaveValue("b");
    expect(screen.getByRole("option", { name: "Alpha" })).toBeInTheDocument();

    fireEvent.change(select, { target: { value: "a" } });
    expect(onChange).toHaveBeenCalledWith("a");
  });
});
