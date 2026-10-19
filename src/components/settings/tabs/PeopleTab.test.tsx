import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("../ContactEditor", () => ({ ContactEditor: () => <div>contacts editor</div> }));
vi.mock("../SubscriptionManager", () => ({ SubscriptionManager: () => <div>subscriptions list</div> }));

import { PeopleTab } from "./PeopleTab";

describe("PeopleTab", () => {
  it("keeps contacts and subscriptions together", () => {
    render(<PeopleTab />);

    expect(screen.getByText("Contacts")).toBeInTheDocument();
    expect(screen.getByText("contacts editor")).toBeInTheDocument();
    expect(screen.getByText("Subscriptions")).toBeInTheDocument();
    expect(screen.getByText("subscriptions list")).toBeInTheDocument();
  });
});
