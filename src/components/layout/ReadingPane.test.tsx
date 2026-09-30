import { act, fireEvent, render, screen } from "@testing-library/react";
import { ReadingPane } from "./ReadingPane";
import { useThreadStore, type Thread } from "@/stores/threadStore";
import { useUIStore } from "@/stores/uiStore";

const route = vi.hoisted(() => ({ id: "broken", accountId: null as string | null }));
vi.mock("@/hooks/useRouteNavigation", () => ({
  useSelectedThreadId: () => route.id,
  useLinkedAccountId: () => route.accountId,
}));
vi.mock("../email/ThreadView", () => ({
  ThreadView: ({ thread }: { thread: Thread }) => {
    if (thread.id === "broken") throw new Error("Message rendering failed");
    return <p>{thread.subject}</p>;
  },
}));

const good = {
  id: "good",
  accountId: "a",
  subject: "Readable email",
} as Thread;

afterEach(() => vi.restoreAllMocks());
beforeEach(() => { route.accountId = null; });

it("shows the details column by default when no conversation is selected", () => {
  route.id = "";
  useUIStore.setState({ contactSidebarVisible: true });
  render(<ReadingPane />);
  expect(screen.getByText("Details")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Hide details" })).toBeInTheDocument();
});

it("resizes the details pane with keyboard controls", () => {
  route.id = "";
  useUIStore.setState({ contactSidebarVisible: true, detailsPaneWidth: 240 });
  render(<ReadingPane />);
  fireEvent.keyDown(screen.getByRole("separator", { name: "Resize details pane" }), { key: "ArrowLeft" });
  expect(useUIStore.getState().detailsPaneWidth).toBe(256);
});

it("recovers from a rendering error when another email is selected", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  route.id = "broken";
  useThreadStore.setState({
    threadMap: new Map([
      ["broken", { ...good, id: "broken" }],
      ["good", good],
    ]),
    cachedThreads: new Map(),
  });
  const view = render(<ReadingPane />);
  expect(screen.getByText("Something went wrong")).toBeInTheDocument();
  route.id = "good";
  view.rerender(<ReadingPane />);
  expect(screen.getByText("Readable email")).toBeInTheDocument();
});

it("keeps the selected email open when the list reloads", () => {
  route.id = "good";
  useThreadStore.setState({
    threadMap: new Map([["good", good]]),
    cachedThreads: new Map([["good", good]]),
  });
  render(<ReadingPane />);
  act(() => useThreadStore.getState().setThreads([]));
  expect(screen.getByText("Readable email")).toBeInTheDocument();
});

it("keeps the linked account when an old list response contains the same thread ID in another account", () => {
  route.id = "good";
  route.accountId = "a";
  useThreadStore.setState({ threadMap: new Map([["good", good]]), cachedThreads: new Map([["good", good]]) });
  render(<ReadingPane />);
  act(() => useThreadStore.getState().setThreads([{ ...good, accountId: "b", subject: "Wrong account" }]));
  expect(screen.getByText("Readable email")).toBeInTheDocument();
  expect(screen.queryByText("Wrong account")).not.toBeInTheDocument();
});
