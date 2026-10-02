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

  it("fetches and caches only messages that have no body", async () => {
    const fetchMessage = vi.fn().mockResolvedValue({ bodyHtml: "<p>Restored</p>", bodyText: null });
    vi.mocked(getEmailProvider).mockResolvedValue({ fetchMessage } as never);

    await expect(recoverMissingBodies("account-1", [
      message("missing"),
      message("already-has-text", null, "cached text"),
    ])).resolves.toBe(true);

    expect(fetchMessage).toHaveBeenCalledExactlyOnceWith("missing");
    expect(updateMissingMessageBody).toHaveBeenCalledExactlyOnceWith(
      "account-1", "missing", "<p>Restored</p>", null,
    );
  });

  it("does not write or report success when the provider still has no body", async () => {
    const fetchMessage = vi.fn().mockResolvedValue({ bodyHtml: null, bodyText: null });
    vi.mocked(getEmailProvider).mockResolvedValue({ fetchMessage } as never);

    await expect(recoverMissingBodies("account-1", [message("empty")])).resolves.toBe(false);
    expect(updateMissingMessageBody).not.toHaveBeenCalled();
  });
});
