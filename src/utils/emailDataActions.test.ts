import { actionForAnchor, decorateEmailData, instrumentEmailActions } from "./emailDataActions";

function documentWith(body: string): Document {
  return new DOMParser().parseFromString(`<body>${body}</body>`, "text/html");
}

describe("emailDataActions", () => {
  it("links bare URLs, email addresses, phone numbers, dates, and street addresses", () => {
    const doc = documentWith(
      "Visit www.example.com, write jane@example.com, call +43 660 123 4567, meet 12.09.2026 at 14:30 at Hauptstraße 12.",
    );

    decorateEmailData(doc);

    const actions = [...doc.querySelectorAll("a")].map((anchor) => actionForAnchor(anchor));
    expect(actions.map((action) => action?.kind)).toEqual(["url", "email", "phone", "date", "address"]);
    expect(actions[3]).toMatchObject({
      startTime: "2026-09-12T14:30",
      endTime: "2026-09-12T15:30",
    });
  });

  it("does not decorate content inside existing anchors", () => {
    const doc = documentWith('<a href="https://example.com">jane@example.com on 12.09.2026</a>');
    decorateEmailData(doc);
    expect(doc.querySelectorAll("a")).toHaveLength(1);
    expect(actionForAnchor(doc.querySelector("a")!)).toMatchObject({ kind: "url" });
  });

  it("does not mistake an ISO date for a phone number", () => {
    const doc = documentWith("The deadline is 2026-09-12.");
    decorateEmailData(doc);
    expect([...doc.querySelectorAll("a")].map((anchor) => anchor.dataset.sndKind)).toEqual(["date"]);
  });

  it("classifies mailto, tel, and app links", () => {
    const doc = documentWith(
      '<a href="mailto:jane@example.com?subject=Hello">Jane</a><a href="tel:+431234567">Call</a><a href="zoommtg://zoom.us/join">Join</a>',
    );
    const actions = [...doc.querySelectorAll("a")].map((anchor) => actionForAnchor(anchor));
    expect(actions).toMatchObject([
      { kind: "email", value: "jane@example.com" },
      { kind: "phone", value: "+431234567" },
      { kind: "app" },
    ]);
  });

  it("leaves fragment and unsafe protocol anchors alone", () => {
    const doc = documentWith('<a href="#section">Jump</a><a href="javascript:alert(1)">Bad</a>');
    expect([...doc.querySelectorAll("a")].map((anchor) => actionForAnchor(anchor))).toEqual([null, null]);
  });

  it("preserves actual web URLs and uses an internal target only for data actions", () => {
    const doc = documentWith('<a href="https://example.com/private?token=secret">Open</a> on 12.09.2026');
    decorateEmailData(doc);
    const actions = instrumentEmailActions(doc, "renderer-7");

    expect(actions.size).toBe(2);
    expect(actions.get("0")).toMatchObject({
      action: { kind: "url" },
      rawHref: "https://example.com/private?token=secret",
    });
    expect([...doc.querySelectorAll("a")].map((anchor) => anchor.getAttribute("href"))).toEqual([
      "https://example.com/private?token=secret",
      "/__snd_email_action__/renderer-7/1",
    ]);
    expect(doc.querySelector("a")!.target).toBe("_top");
  });

  it("does not rewrite or duplicate actions when a document is rebound", () => {
    const doc = documentWith('<a href="https://example.com">Open</a>');
    const first = instrumentEmailActions(doc, "renderer-1");
    const href = doc.querySelector("a")!.href;
    const second = instrumentEmailActions(doc, "renderer-1");

    expect(first.size).toBe(1);
    expect(second.size).toBe(0);
    expect(doc.querySelector("a")!.href).toBe(href);
  });

  it.each([
    ["1455 3rd Street<br>San Francisco, CA 94158", "1455 3rd Street, San Francisco, CA 94158"],
    ["<p>1455 <span>3rd Street</span></p><p>San Francisco, CA 94158</p>", "1455 3rd Street, San Francisco, CA 94158"],
    ["Hauptstraße 12<br>1010 Wien<br>Österreich", "Hauptstraße 12, 1010 Wien, Österreich"],
    ["Hauptstraße 12, 1010 Wien", "Hauptstraße 12, 1010 Wien"],
  ])("recognizes the complete postal address across HTML text segments: %s", (html, expected) => {
    const doc = documentWith(`${html}<br><a href="https://example.com/unsubscribe">Unsubscribe</a>`);
    const before = doc.body.textContent;
    decorateEmailData(doc);
    const addresses = [...doc.querySelectorAll<HTMLAnchorElement>('a[data-snd-kind="address"]')];
    expect(addresses.length).toBeGreaterThan(0);
    expect(addresses.every((anchor) => actionForAnchor(anchor)?.value === expected)).toBe(true);
    expect(addresses[0]!.textContent).toContain(expected.split(" ")[0]);
    expect(doc.body.textContent).toBe(before);
    expect(doc.querySelectorAll('a[href="https://example.com/unsubscribe"]')).toHaveLength(1);
  });

  it("does not join addresses across separate table cells", () => {
    const doc = documentWith('<table><tr><td>1455 3rd Street</td><td>San Francisco, CA 94158</td></tr></table>');
    decorateEmailData(doc);
    expect(actionForAnchor(doc.querySelector("a")!)?.value).toBe("1455 3rd Street");
  });
});
