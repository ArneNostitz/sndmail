import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("../LabelEditor", () => ({ LabelEditor: () => <div>labels editor</div> }));
vi.mock("../FilterEditor", () => ({ FilterEditor: () => <div>filters editor</div> }));
vi.mock("../SmartLabelEditor", () => ({ SmartLabelEditor: () => <div>smart labels editor</div> }));
vi.mock("../SmartFolderEditor", () => ({ SmartFolderEditor: () => <div>smart folders editor</div> }));
vi.mock("../QuickStepEditor", () => ({ QuickStepEditor: () => <div>quick steps editor</div> }));
vi.mock("../BundleSettings", () => ({ BundleSettings: () => <div>bundling settings</div> }));

import { MailRulesTab } from "./MailRulesTab";

describe("MailRulesTab", () => {
  it("carries every rule editor exactly once", () => {
    render(<MailRulesTab />);

    for (const heading of ["Labels", "Filters", "Smart Labels", "Smart Folders", "Quick Steps", "Bundling & Delivery Schedules"]) {
      expect(screen.getByText(heading)).toBeInTheDocument();
    }
    for (const editor of ["labels editor", "filters editor", "smart labels editor", "smart folders editor", "quick steps editor", "bundling settings"]) {
      expect(screen.getByText(editor)).toBeInTheDocument();
    }
  });
});
