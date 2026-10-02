import { recoverMissingBodies } from "./recoverMissingBodies";
import { updateMissingMessageBody } from "../db/messages";
import { getEmailProvider } from "../email/providerFactory";

vi.mock("../db/messages", () => ({ updateMissingMessageBody: vi.fn() }));
vi.mock("../email/providerFactory", () => ({ getEmailProvider: vi.fn() }));

function message(id: string, bodyHtml: string | null = null, bodyText: string | null = null) {
  return {
    id, account_id: "account-1", thread_id: "thread-1", body_html: bodyHtml, body_text: bodyText,
  } as never;
}

describe("recoverMissingBodies", () => {
  beforeEach(() => vi.clearAllMocks());

  it("fetches an HTML rendition for text-only cached messages", async () => {
    const fetchMessage = vi.fn().mockImplementation(async (id: string) => ({
      bodyHtml: id === "text-only" ? "<p>Formatted</p>" : "<p>Restored</p>",
      bodyText: "provider text",
    }));
    vi.mocked(getEmailProvider).mockResolvedValue({ fetchMessage } as never);

    await expect(recoverMissingBodies("account-1", [
      message("missing-body"),
      message("text-only", null, "cached text"),
    ])).resolves.toBe(true);

    expect(fetchMessage).toHaveBeenCalledTimes(2);
    expect(fetchMessage).toHaveBeenNthCalledWith(1, "missing-body");
    expect(fetchMessage).toHaveBeenNthCalledWith(2, "text-only");
    expect(updateMissingMessageBody).toHaveBeenNthCalledWith(
      2, "account-1", "text-only", "<p>Formatted</p>", "provider text",
    );
  });

  it("does not refetch a known text-only message after checking it once", async () => {
    const fetchMessage = vi.fn().mockResolvedValue({ bodyHtml: null, bodyText: "provider text" });
    vi.mocked(getEmailProvider).mockResolvedValue({ fetchMessage } as never);
    const textOnly = message("known-text-only", null, "cached text");

    await expect(recoverMissingBodies("account-1", [textOnly])).resolves.toBe(false);
    await expect(recoverMissingBodies("account-1", [textOnly])).resolves.toBe(false);

    expect(fetchMessage).toHaveBeenCalledExactlyOnceWith("known-text-only");
    expect(updateMissingMessageBody).not.toHaveBeenCalled();
  });

  it("does not write or report success when the provider still has no body", async () => {
    const fetchMessage = vi.fn().mockResolvedValue({ bodyHtml: null, bodyText: null });
    vi.mocked(getEmailProvider).mockResolvedValue({ fetchMessage } as never);

    await expect(recoverMissingBodies("account-1", [message("empty")])).resolves.toBe(false);
    expect(updateMissingMessageBody).not.toHaveBeenCalled();
  });
});
