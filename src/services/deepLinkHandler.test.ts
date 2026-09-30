import { vi, beforeEach, describe, it, expect } from "vitest";

const mocks = vi.hoisted(() => ({
  current: vi.fn(), onOpen: vi.fn(), listen: vi.fn(), openMail: vi.fn(), composer: vi.fn(),
  show: vi.fn(), focus: vi.fn(), report: vi.fn(), cleanup: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-deep-link", () => ({ getCurrent: mocks.current, onOpenUrl: mocks.onOpen }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ WebviewWindow: { getByLabel: async () => ({ show: mocks.show, setFocus: mocks.focus }) } }));
vi.mock("../stores/composerStore", () => ({ useComposerStore: { getState: () => ({ openComposer: mocks.composer }) } }));
vi.mock("./threads/openMailLink", () => ({ openMailLink: mocks.openMail }));
vi.mock("../stores/toastStore", () => ({ reportError: mocks.report }));
import { handleUrl, initDeepLinkHandler } from "./deepLinkHandler";

beforeEach(() => {
  vi.clearAllMocks(); mocks.current.mockResolvedValue(null);
  mocks.onOpen.mockResolvedValue(mocks.cleanup); mocks.listen.mockResolvedValue(mocks.cleanup);
  mocks.openMail.mockResolvedValue(undefined);
});

describe("native mail link delivery", () => {
  it("opens a cold-start link after registering listeners", async () => {
    mocks.current.mockResolvedValue(["sndmail://open?account=a&thread=t&message=m"]);
    const cleanup = await initDeepLinkHandler();
    expect(mocks.openMail).toHaveBeenCalledWith({ accountId: "a", threadId: "t", messageId: "m" });
    expect(mocks.onOpen.mock.invocationCallOrder[0]).toBeLessThan(mocks.current.mock.invocationCallOrder[0]!);
    cleanup(); expect(mocks.cleanup).toHaveBeenCalledTimes(2);
  });
  it("coalesces warm OS, single-instance, and startup duplicate deliveries", async () => {
    const url = "sndmail://open?account=a&thread=t";
    mocks.onOpen.mockImplementation(async (receive) => { receive([url]); return mocks.cleanup; });
    mocks.listen.mockImplementation(async (_name, receive) => { receive({ payload: ["app", url] }); return mocks.cleanup; });
    mocks.current.mockResolvedValue([url]);
    const cleanup = await initDeepLinkHandler();
    expect(mocks.openMail).toHaveBeenCalledTimes(1); cleanup();
  });
  it("reports failures and continues processing subsequent links", async () => {
    mocks.current.mockResolvedValue(["sndmail://open?account=a", "sndmail://open?account=a&thread=t"]);
    const cleanup = await initDeepLinkHandler();
    expect(mocks.report).toHaveBeenCalledWith("Could not open mail link", expect.any(Error));
    expect(mocks.openMail).toHaveBeenCalledTimes(1); cleanup();
  });
  it("preserves mailto composition with escaped body", async () => {
    await handleUrl("mailto:one@example.com?subject=Hello&body=%3Cscript%3E");
    expect(mocks.composer).toHaveBeenCalledWith(expect.objectContaining({ to: ["one@example.com"], subject: "Hello", bodyHtml: "<p>&lt;script&gt;</p>" }));
    expect(mocks.openMail).not.toHaveBeenCalled();
  });
});
