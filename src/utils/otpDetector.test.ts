import { describe, it, expect } from "vitest";
import { detectOtpCode, detectSignInLink } from "./otpDetector";
import linkCases from "../../src-tauri/tests/fixtures/sign_in_link_cases.json";

describe("detectOtpCode", () => {
  it("reads a code out of the subject", () => {
    expect(detectOtpCode("493028 is your verification code", null)?.code).toBe("493028");
  });

  it("reads the common body phrasing", () => {
    expect(detectOtpCode(null, "Your verification code is 728193. It expires in 10 minutes.")?.code)
      .toBe("728193");
  });

  it("handles a code the sender split for readability", () => {
    expect(detectOtpCode(null, "Security code: 123 456")?.code).toBe("123456");
  });

  it("handles German", () => {
    expect(detectOtpCode(null, "Ihr Bestätigungscode lautet 884201.")?.code).toBe("884201");
  });

  it("takes an alphanumeric code", () => {
    expect(detectOtpCode(null, "Your login code is A1B2C3")?.code).toBe("A1B2C3");
  });

  it("picks the code nearest the words that qualify it", () => {
    const body = "Order 55512345 shipped. Your security code is 664120. Ref 99887766.";
    expect(detectOtpCode(null, body)?.code).toBe("664120");
  });

  // Everything below would overwrite the user's clipboard if it matched
  it("ignores an order number with no code wording", () => {
    expect(detectOtpCode("Order 4851209 confirmed", "Your parcel is on the way.")).toBeNull();
  });

  it("ignores a year", () => {
    expect(detectOtpCode(null, "Your security code expires in 2026")).toBeNull();
  });

  it("ignores a password-changed notice", () => {
    expect(detectOtpCode("Your password was changed", "If this was not you, contact us on 8005551234."))
      .toBeNull();
  });

  it("ignores a repeated-digit placeholder", () => {
    expect(detectOtpCode(null, "Your verification code is 000000")).toBeNull();
  });

  it("ignores an invoice total near the word code", () => {
    expect(detectOtpCode(null, "Promo code applied. Total: 1899")).toBeNull();
  });

  it("returns null on an empty message", () => {
    expect(detectOtpCode(null, null)).toBeNull();
  });
});

describe("detectSignInLink", () => {
  it.each(linkCases)("follows shared one-time sign-in contract: $name", ({ html, context, expected_url }) => {
    const result = detectSignInLink(html, null, context);
    expect(result ? result.url : null).toBe(expected_url);
  });

  it("keeps a genuine sign-in link when an unrelated footer mentions subscriptions", () => {
    const html = '<a href="https://click.example/magic?token=opaque">Sign in</a><a href="https://example.com/manage-subscription">Manage subscription</a>';
    expect(detectSignInLink(html, null, "Use this one-time sign-in link. Manage your subscription preferences below.")?.url)
      .toBe("https://click.example/magic?token=opaque");
  });

  it("recognizes auth context in HTML when plain text contains only an OTP", () => {
    const html = '<a href="https://app.example.com/magic?token=9">Anmelden</a><p>Use this one-time sign-in link</p><p>Oder dieser Code</p><p>271260</p>';
    expect(detectSignInLink(html, "Dein Login", "Anmelden\nOder dieser Code\n271260\n")?.url)
      .toBe("https://app.example.com/magic?token=9");
  });

  it("returns the explicit one-time magic link URL and anchor label", () => {
    const html = '<a href="https://click.example/track?state=opaque-123">Sign in to your account</a>';
    expect(detectSignInLink(html, null, "Use this one-time sign-in link. It expires in 10 minutes and can only be used once.")).toEqual({
      url: "https://click.example/track?state=opaque-123",
      label: "Sign in to your account",
    });
  });

  it("rejects generic login wording without one-time message context", () => {
    expect(detectSignInLink('<a href="https://app.example.com/magic?t=abc">Sign in to your account</a>', "", "")).toBeNull();
  });

  it("rejects a normal login page even when nearby copy says one-time", () => {
    expect(detectSignInLink('<a href="https://example.com/login">Sign in</a>', null, "Use this one-time sign-in link.")).toBeNull();
  });

  it("rejects a generic continue link beside one-time context", () => {
    expect(detectSignInLink('<a href="https://example.com/auth/magic?token=opaque">Continue</a>', null, "Use this one-time sign-in link.")).toBeNull();
  });

  it("never picks the unsubscribe link", () => {
    const html = '<a href="https://example.com/unsubscribe?login=1">Unsubscribe</a>';
    expect(detectSignInLink(html)).toBeNull();
  });

  it("skips images that happen to sit in an anchor", () => {
    const html = '<a href="https://cdn.example.com/login-banner.png">Verify</a>';
    expect(detectSignInLink(html)).toBeNull();
  });

  it("ignores mailto and other schemes", () => {
    expect(detectSignInLink('<a href="mailto:a@b.com">Confirm</a>')).toBeNull();
  });

  it("returns null for an ordinary newsletter", () => {
    const html = '<a href="https://example.com/blog/post">Read our latest post</a>';
    expect(detectSignInLink(html)).toBeNull();
  });

  it("returns null with no body", () => {
    expect(detectSignInLink(null)).toBeNull();
  });
});

describe("detectOtpCode - a bare 'code' label", () => {
  // Verbatim shape from a real magic-link mail: a button, then the code under
  // a heading that says nothing but "code"
  it("takes the code under 'ODER DIESER CODE'", () => {
    // The real mail's shape: the label on one line, the digits alone on the next
    const body = "Tipp auf den Knopf — oder gib den Code in der App ein.\nAnmelden\nODER DIESER CODE\n221818\n"
      + "Beides gilt 15 Minuten.";
    expect(detectOtpCode("Dein MatchMii-Login", body)?.code).toBe("221818");
  });

  it("takes 'Code: 884201' with no other wording", () => {
    expect(detectOtpCode(null, "Code: 884201")?.code).toBe("884201");
  });

  it("does not take a promo code", () => {
    expect(detectOtpCode(null, "Use promo code 556677 for 20% off")).toBeNull();
  });

  it("does not take an order code", () => {
    expect(detectOtpCode(null, "Your order code is 4851209")).toBeNull();
  });

  it("does not take a tracking code", () => {
    expect(detectOtpCode(null, "Tracking code 998877 — on its way")).toBeNull();
  });

  it("does not match 'code' inside a longer word", () => {
    expect(detectOtpCode(null, "Postcode 102030 is where we ship")).toBeNull();
  });

  it("will not take a 4-digit number on a bare 'code' alone", () => {
    // Too weak: four digits next to the word "code" is not enough evidence
    expect(detectOtpCode(null, "Code 1234")).toBeNull();
  });
});

describe("detectOtpCode - the false positives that copied junk", () => {
  it("does not read 'otp' inside a tracking-URL token", () => {
    // A newsletter footer: a hex token containing "otp", then the address.
    // This copied a Berlin postal code onto the clipboard.
    const body = "(https://x.example/?u=4d560eede&id=05e9824dc2&t=b&e=87b4442e8f&c=ccc19e5aotp1d)\n"
      + "Mein Grundeinkommen e.V. (gemeinnützig)\nLeipziger Str. 56, 10117 Berlin\nImpressum";
    expect(detectOtpCode("Im September haben Sie erneut die Chance", body)).toBeNull();
  });

  it("does not take a postal code even next to real code wording", () => {
    expect(detectOtpCode(null, "Your security code was sent. Leipziger Str. 56, 10117 Berlin")).toBeNull();
  });

  it("still takes a code on its own line under a bare label", () => {
    expect(detectOtpCode("Dein MatchMii-Login", "Anmelden\nOder dieser Code\n271260\nBeides gilt 15 Minuten")?.code)
      .toBe("271260");
  });

  it("still takes 'Code: 884201' on one line", () => {
    expect(detectOtpCode(null, "Hallo\nCode: 884201\nDanke")?.code).toBe("884201");
  });

  it("does not take a number that merely sits near the word code inside prose", () => {
    // Weak evidence and the number is not set apart — could be anything
    expect(detectOtpCode(null, "Use the code from the app; ref 123456 was logged earlier.")).toBeNull();
  });

  it("matches a keyword only as a whole word", () => {
    expect(detectOtpCode(null, "The hotplate 665544 model")).toBeNull();
    expect(detectOtpCode(null, "Your OTP is 665544")?.code).toBe("665544");
  });
});
