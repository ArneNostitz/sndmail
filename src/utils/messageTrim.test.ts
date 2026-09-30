import { trimHtmlBody, trimTextBody, trimMessageBody, previewText } from "./messageTrim";

describe("trimHtmlBody", () => {
  it("removes a Gmail quote block", () => {
    const html =
      '<div>Hi Sam, bekommst dus jetzt?</div><div class="gmail_quote"><blockquote>old mail</blockquote></div>';
    const result = trimHtmlBody(html);
    expect(result.trimmed).toBe(true);
    expect(result.html).toContain("Hi Sam");
    expect(result.html).not.toContain("old mail");
  });

  it("removes sndmail quote and signature attributes", () => {
    const result = trimHtmlBody(
      '<p>New note</p><div data-sndmail-quote>Old reply</div><div data-sndmail-signature>Old signature</div>',
    );
    expect(result.html).toContain("New note");
    expect(result.html).not.toContain("Old reply");
    expect(result.html).not.toContain("Old signature");
  });

  it("removes a bare blockquote", () => {
    const result = trimHtmlBody("<p>Sure thing</p><blockquote>quoted</blockquote>");
    expect(result.trimmed).toBe(true);
    expect(result.html).not.toContain("quoted");
  });

  it("removes an attribution line and everything after it", () => {
    const html =
      "<div>Thanks!</div><div>On Tue, Sep 1, 2026 at 23:27, Arne wrote:</div><div>previous body</div>";
    const result = trimHtmlBody(html);
    expect(result.trimmed).toBe(true);
    expect(result.html).toContain("Thanks!");
    expect(result.html).not.toContain("previous body");
    expect(result.html).not.toContain("wrote:");
  });

  it("removes a trailing signature block", () => {
    const html = "<div>See you</div><div>--</div><div>Arne Nostitz-Rieneck</div>";
    const result = trimHtmlBody(html);
    expect(result.trimmed).toBe(true);
    expect(result.html).not.toContain("Nostitz");
  });

  it("removes a Gmail signature container", () => {
    const html = '<div>Body text</div><div class="gmail_signature">Best, Arne</div>';
    const result = trimHtmlBody(html);
    expect(result.trimmed).toBe(true);
    expect(result.html).not.toContain("Best, Arne");
  });

  it("leaves an unquoted body untouched", () => {
    const html = "<p>Just a normal message</p>";
    expect(trimHtmlBody(html)).toEqual({ html, trimmed: false, empty: false });
  });

  it("reports a body that is nothing but a quote as empty", () => {
    const result = trimHtmlBody("<blockquote>everything is a quote</blockquote>");
    expect(result.trimmed).toBe(true);
    expect(result.empty).toBe(true);
  });

  it("treats a bare forward as empty rather than keeping the quoted mail", () => {
    // The shape sndmail's own forward produces: no note, attribution, then quote
    const html =
      '<html><body><br> <br><div class="gmail_signature"></div>'
      + '<p class="gmail_quote">On 8. May 2026 at 15:21:52, Rainer Newald wrote:</p>'
      + '<blockquote type="cite" class="gmail_quote"><div>a whole newsletter</div></blockquote>'
      + "</body></html>";
    const result = trimHtmlBody(html);
    expect(result.trimmed).toBe(true);
    expect(result.empty).toBe(true);
    expect(result.html).not.toContain("newsletter");
  });

  it("keeps the note above an Apple Mail reply and drops the footer with it", () => {
    // Real shape: text, "Sent from my iPhone", then the quoted chain
    const html =
      '<body dir="auto">Gehst du ?<br><div dir="ltr">Sent from my iPhone</div>'
      + '<div dir="ltr"><br><blockquote type="cite">On May 8, 2026, at 5:35 PM, Arne wrote:<br></blockquote></div>'
      + '<blockquote type="cite"><div>the forwarded invitation</div></blockquote></body>';
    const result = trimHtmlBody(html);
    expect(result.trimmed).toBe(true);
    expect(result.empty).toBe(false);
    expect(result.html).toContain("Gehst du ?");
    expect(result.html).not.toContain("Sent from my iPhone");
    expect(result.html).not.toContain("invitation");
  });

  it("cuts an attribution that runs into the quote in the same node", () => {
    const html = "<div>On 13. July 2026 at 08:08:33, Thalia.at wrote: Alles was die Ferien</div>";
    const result = trimHtmlBody(html);
    expect(result.trimmed).toBe(true);
    expect(result.html).not.toContain("Ferien");
  });

  it("leaves a quote-shaped phrase inside real prose alone", () => {
    const html = "<p>I asked her about it and she wrote: nothing at all.</p>";
    expect(trimHtmlBody(html).trimmed).toBe(false);
  });

  it("keeps a body that is only an image", () => {
    const html = '<div><img src="cid:x"></div><blockquote>quoted</blockquote>';
    const result = trimHtmlBody(html);
    expect(result.empty).toBe(false);
  });
});

describe("previewText", () => {
  it("previews the trimmed body, not the quote", () => {
    const result = trimMessageBody(
      "<div>\u{1F648}\u{1F648}</div><blockquote>On Jul 13 someone wrote a lot</blockquote>",
      null,
    );
    expect(previewText(result)).toBe("\u{1F648}\u{1F648}");
  });

  it("drops the invisible padding newsletters pad their preheader with", () => {
    const result = trimMessageBody("<div>Real text\u200c\u034f\u200c\u034f</div>", null);
    expect(previewText(result)).toBe("Real text");
  });

  it("collapses whitespace to one line", () => {
    const result = trimMessageBody("<div>two\n\n   lines</div>", null);
    expect(previewText(result)).toBe("two lines");
  });
});

describe("trimTextBody", () => {
  it("drops a trailing run of quoted lines", () => {
    const text = "My reply\n\n> old line\n> another old line";
    const result = trimTextBody(text);
    expect(result.trimmed).toBe(true);
    expect(result.text).toBe("My reply");
  });

  it("drops everything from the signature separator", () => {
    const result = trimTextBody("Body\n\n-- \nArne\nCEO");
    expect(result.trimmed).toBe(true);
    expect(result.text).toBe("Body");
  });

  it("drops an attribution line and the quote under it", () => {
    const result = trimTextBody("Sure\nOn Tue, Sep 1, 2026 at 23:27, Arne wrote:\nold");
    expect(result.trimmed).toBe(true);
    expect(result.text).toBe("Sure");
  });

  it("leaves a plain body untouched", () => {
    const text = "Nothing to trim here";
    expect(trimTextBody(text)).toEqual({ text, trimmed: false, empty: false });
  });

  it("reports a text body that is only a quote as empty", () => {
    const result = trimTextBody("> only a quote");
    expect(result.trimmed).toBe(true);
    expect(result.empty).toBe(true);
  });

  it("drops an Apple Mail footer", () => {
    const result = trimTextBody("Gehst du ?\nSent from my iPhone\nOn May 8 Arne wrote:");
    expect(result.text).toBe("Gehst du ?");
  });
});

describe("trimMessageBody", () => {
  it("prefers the HTML body", () => {
    const result = trimMessageBody("<p>hi</p><blockquote>q</blockquote>", "hi\n> q");
    expect(result.trimmed).toBe(true);
    expect(result.html).not.toContain("<blockquote>");
  });

  it("falls back to text when there is no HTML", () => {
    const result = trimMessageBody(null, "hi\n> q");
    expect(result.trimmed).toBe(true);
    expect(result.text).toBe("hi");
  });

  it("handles an empty message", () => {
    expect(trimMessageBody(null, null)).toEqual({
      html: null,
      text: null,
      trimmed: false,
      empty: true,
    });
  });
});
