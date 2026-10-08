import { act, fireEvent, render, screen } from "@testing-library/react";
import { SearchBar } from "./SearchBar";
import { useThreadStore } from "@/stores/threadStore";
import { searchMessages } from "@/services/db/search";

vi.mock("@/services/db/search", () => ({ searchMessages: vi.fn() }));
const semanticState = vi.hoisted(() => ({ ready: false, search: vi.fn() }));
vi.mock("@/services/search/semanticSearchRuntime", () => ({
  isSemanticSearchReady: () => semanticState.ready,
  semanticSearch: semanticState.search,
}));
vi.mock("@/hooks/useRouteNavigation", () => ({
  useActiveLabel: () => "inbox",
}));
vi.mock("@/components/ui/InputDialog", () => ({ InputDialog: () => null }));
vi.mock("@/stores/accountStore", () => ({
  useAccountStore: (select: (s: unknown) => unknown) =>
    select({ activeAccountId: "a", unifiedInbox: false }),
  listedAccountIds: () => ["a"],
}));

describe("SearchBar", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    semanticState.ready = false;
    semanticState.search.mockReset();
    useThreadStore.getState().clearSearch();
  });
  afterEach(() => vi.useRealTimers());
  it("only reveals search scopes and presets after text is entered", () => {
    render(<SearchBar />);
    expect(screen.queryByRole("group", { name: "Search folders" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Search filters" })).toBeNull();

    const input = screen.getByRole("textbox");
    fireEvent.focus(input);
    fireEvent.change(input, {
      target: { value: "invoice" },
    });
    expect(screen.getByRole("group", { name: "Search folders" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Has attachments" })).toBeInTheDocument();
  });

  it("shows the anchored search options on hover and while the field is focused", async () => {
    render(<SearchBar />);
    const input = screen.getByRole("textbox");
    const searchArea = input.parentElement!.parentElement!;

    fireEvent.mouseEnter(searchArea);
    expect(screen.getByRole("group", { name: "Search filters" })).toBeInTheDocument();
    fireEvent.mouseLeave(searchArea);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.queryByRole("group", { name: "Search filters" })).toBeNull();

    fireEvent.focus(input);
    expect(screen.getByRole("group", { name: "Search filters" })).toBeInTheDocument();
  });

  it("adds and removes preset operators without discarding the typed search", () => {
    render(<SearchBar />);
    const input = screen.getByRole("textbox");
    fireEvent.focus(input);
    fireEvent.change(input, {
      target: { value: "invoice" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Has attachments" }));
    expect(useThreadStore.getState().searchQuery).toBe("invoice has:attachment");
    fireEvent.click(screen.getByRole("button", { name: "Has attachments" }));
    expect(useThreadStore.getState().searchQuery).toBe("invoice");
    fireEvent.click(screen.getByRole("button", { name: "From" }));
    expect(useThreadStore.getState().searchQuery).toBe("invoice from:");
    expect(screen.getByRole("status")).toHaveTextContent("Type a value");
  });

  it("retains matching message ids and the body excerpt for display", async () => {
    vi.mocked(searchMessages).mockResolvedValue([
      {
        message_id: "m1",
        account_id: "a",
        thread_id: "t1",
        subject: "A subject",
        from_name: "Mara",
        from_address: "mara@example.com",
        snippet: "Old provider snippet",
        match_excerpt: "The exact invoice line is here",
        date: 1,
        rank: 0,
      },
    ]);
    render(<SearchBar />);
    const input = screen.getByRole("textbox");
    fireEvent.focus(input);
    fireEvent.change(input, {
      target: { value: "invoice" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(useThreadStore.getState().searchMatches.get("t1")).toEqual({
      messageIds: new Set(["m1"]),
      excerpt: "The exact invoice line is here",
    });
  });

  it("scopes to Inbox and expands to all folders without changing the query", async () => {
    vi.mocked(searchMessages).mockResolvedValue([]);
    render(<SearchBar />);
    const input = screen.getByRole("textbox");
    fireEvent.focus(input);
    fireEvent.change(input, {
      target: { value: "invoice" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(searchMessages).toHaveBeenLastCalledWith(
      "invoice",
      "a",
      500,
      expect.objectContaining({ labelIds: ["INBOX"], excludeSpamTrash: true }),
    );
    fireEvent.click(screen.getByRole("button", { name: "All folders" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(searchMessages).toHaveBeenLastCalledWith(
      "invoice",
      "a",
      500,
      expect.objectContaining({ labelIds: [], excludeSpamTrash: false }),
    );
  });
  it("does not resurrect a cleared query when its request finishes", async () => {
    let finish!: (hits: never[]) => void;
    vi.mocked(searchMessages).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    render(<SearchBar />);
    const input = screen.getByRole("textbox");
    fireEvent.focus(input);
    fireEvent.change(input, {
      target: { value: "invoice" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    await act(async () => {
      finish([]);
    });
    expect(useThreadStore.getState().searchQuery).toBe("");
    expect(useThreadStore.getState().searchThreadIds).toBeNull();
  });
  it("shows failures instead of reverting to an unfiltered mailbox", async () => {
    vi.mocked(searchMessages).mockRejectedValue(
      new Error("Database unavailable"),
    );
    render(<SearchBar />);
    const input = screen.getByRole("textbox");
    fireEvent.focus(input);
    fireEvent.change(input, {
      target: { value: "invoice" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Database unavailable");
    expect(useThreadStore.getState().searchThreadIds?.size).toBe(0);
  });

  it("merges semantic hits on top of keyword matches when the index is ready", async () => {
    vi.mocked(searchMessages).mockResolvedValue([
      {
        message_id: "m1",
        account_id: "a",
        thread_id: "t1",
        subject: "A subject",
        from_name: "Mara",
        from_address: "mara@example.com",
        snippet: "Keyword snippet",
        match_excerpt: "Keyword excerpt",
        date: 1,
        rank: 0,
      },
    ]);
    semanticState.ready = true;
    semanticState.search.mockResolvedValue({
      hits: [
        {
          id: "doc-2",
          title: "Another subject",
          snippet: "Semantic excerpt",
          tags: ["a", "INBOX"],
          metadata: { account: "a", threadId: "t2", messageId: "m2" },
          matchKind: "hybrid",
          relevance: 0.9,
        },
      ],
    });
    render(<SearchBar />);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "invoice" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(semanticState.search).toHaveBeenCalledWith("invoice", 100);
    const matches = useThreadStore.getState().searchMatches;
    expect(matches.get("t1")).toEqual({
      messageIds: new Set(["m1"]),
      excerpt: "Keyword excerpt",
    });
    expect(matches.get("t2")).toEqual({
      messageIds: new Set(["m2"]),
      excerpt: "Semantic excerpt",
    });
  });

  it("stays keyword-only when the semantic toggle is switched off", async () => {
    vi.mocked(searchMessages).mockResolvedValue([]);
    semanticState.ready = true;
    render(<SearchBar />);
    const input = screen.getByRole("textbox");
    fireEvent.focus(input);
    fireEvent.change(input, {
      target: { value: "invoice" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(semanticState.search).toHaveBeenCalledWith("invoice", 100);
    semanticState.search.mockClear();
    const toggle = screen.getByRole("button", { name: /Semantic/ });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(semanticState.search).not.toHaveBeenCalled();
  });

  it("stays keyword-only when the semantic index is not ready", async () => {
    vi.mocked(searchMessages).mockResolvedValue([]);
    render(<SearchBar />);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "invoice" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(semanticState.search).not.toHaveBeenCalled();
    expect(useThreadStore.getState().searchThreadIds?.size).toBe(0);
  });

  it("keeps keyword results when the semantic query fails", async () => {
    vi.mocked(searchMessages).mockResolvedValue([
      {
        message_id: "m1",
        account_id: "a",
        thread_id: "t1",
        subject: "A subject",
        from_name: "Mara",
        from_address: "mara@example.com",
        snippet: "Keyword snippet",
        match_excerpt: "Keyword excerpt",
        date: 1,
        rank: 0,
      },
    ]);
    semanticState.ready = true;
    semanticState.search.mockRejectedValue(new Error("Index unavailable"));
    render(<SearchBar />);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "invoice" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(useThreadStore.getState().searchMatches.get("t1")).toEqual({
      messageIds: new Set(["m1"]),
      excerpt: "Keyword excerpt",
    });
  });
});
