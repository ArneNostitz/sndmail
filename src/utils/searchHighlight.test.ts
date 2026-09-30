import {
  getBodySearchTerms,
  getListSearchTerms,
  highlightSearchTerms,
  splitSearchMatches,
} from "./searchHighlight";

describe("searchHighlight", () => {
  it("keeps body highlighting limited to free text", () => {
    expect(getBodySearchTerms('from:mara@example.com "festival pass"')).toEqual([
      "festival pass",
    ]);
    expect(getListSearchTerms('from:mara@example.com "festival pass"')).toEqual([
      "mara@example.com",
      "festival pass",
    ]);
  });

  it("splits matches case-insensitively while preserving their text", () => {
    expect(splitSearchMatches("The Festival starts", ["festival"])).toEqual([
      { text: "The ", matched: false },
      { text: "Festival", matched: true },
      { text: " starts", matched: false },
    ]);
  });

  it("wraps body text without touching scripts or existing marks", () => {
    const root = document.createElement("div");
    root.innerHTML = "<p>Festival details</p><style>.festival{}</style><mark>Festival</mark>";
    expect(highlightSearchTerms(root, ["festival"])).toBe(1);
    expect(root.querySelectorAll('mark[data-sndmail-search-match="true"]')).toHaveLength(1);
    expect(root.querySelector("style")?.textContent).toBe(".festival{}");
    expect(root.querySelectorAll("mark")).toHaveLength(2);
  });
});
