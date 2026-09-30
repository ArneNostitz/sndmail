import { createMailLink, parseMailLink } from "./mailLink";

describe("public mail links", () => {
  it("round-trips encoded IMAP and account identifiers", () => {
    const target = { accountId: "a+one@example.com", threadId: "imap-a-Project / Travel-12", messageId: "imap-a-A&B / 旅行-42" };
    expect(parseMailLink(createMailLink(target))).toEqual(target);
  });
  it("allows a thread-only link", () => {
    expect(parseMailLink("velo://open?account=a&thread=t")).toEqual({ accountId: "a", threadId: "t" });
  });
  it("creates canonical sndmail links and still accepts Velo links", () => {
    const target = { accountId: "a", threadId: "t", messageId: "m" };
    expect(createMailLink(target)).toBe("sndmail://open?account=a&thread=t&message=m");
    expect(parseMailLink("sndmail://open?account=a&thread=t&message=m")).toEqual(target);
    expect(parseMailLink("velo://open?account=a&thread=t&message=m")).toEqual(target);
  });
  it.each([
    "velo://delete?account=a&thread=t", "https://open?account=a&thread=t",
    "velo://user@open?account=a&thread=t", "velo://open/file?account=a&thread=t",
    "velo://open?account=a&thread=t#x", "velo://open?account=a&thread=t&thread=other",
    "velo://open?account=a&thread=t&message=", "velo://open?account=a&thread=t&execute=x",
    "velo://open?account=a&thread=%00", "velo://open?thread=t",
  ])("rejects malformed or ambiguous input: %s", (url) => {
    expect(() => parseMailLink(url)).toThrow();
  });
});
