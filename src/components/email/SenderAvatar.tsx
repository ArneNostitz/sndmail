import { useEffect, useState } from "react";
import { getGravatarUrl } from "@/services/contacts/gravatar";

/**
 * Freemail domains whose favicon would show the provider's logo, not the
 * sender's identity — those senders fall straight back to the initial.
 */
const GENERIC_DOMAINS = new Set([
  "gmail.com", "googlemail.com",
  "outlook.com", "outlook.de", "hotmail.com", "hotmail.de", "live.com", "live.de", "msn.com",
  "yahoo.com", "yahoo.de", "ymail.com",
  "icloud.com", "me.com", "mac.com",
  "aol.com", "protonmail.com", "proton.me", "pm.me",
  "gmx.at", "gmx.de", "gmx.net", "gmx.com", "web.de", "t-online.de", "freenet.de",
  "mail.com", "posteo.de", "mailbox.org", "fastmail.com", "zoho.com",
]);

type AvatarSource = "gravatar" | "favicon" | "initial";

// Remember what resolved per address so scrolling never re-requests dead URLs
const sourceCache = new Map<string, AvatarSource>();
const gravatarChecks = new Map<string, Promise<boolean>>();
const verifiedGravatars = new Set<string>();

function checkGravatar(address: string): Promise<boolean> {
  const existing = gravatarChecks.get(address);
  if (existing) return existing;

  const check = fetch(getGravatarUrl(address), { method: "HEAD" })
    .then((response) => response.ok)
    .catch(() => false);
  gravatarChecks.set(address, check);
  return check;
}

function firstSource(address: string): AvatarSource {
  const cached = sourceCache.get(address);
  if (cached) return cached;
  return address ? "gravatar" : "initial";
}

function nextSource(current: AvatarSource, domain: string): AvatarSource {
  if (current === "gravatar" && domain && !GENERIC_DOMAINS.has(domain)) return "favicon";
  return "initial";
}

/**
 * Airmail-style sender avatar for the thread list: the sender's Gravatar
 * photo, then their domain's favicon (company logo), then the initial circle.
 *
 * The avatar says who wrote, never whether the mail was read — a photo cannot
 * change colour, so a read/unread tint only ever applied to the third of
 * senders that fall back to an initial. Unread is drawn around the avatar
 * (a ring, a dot) by the caller instead.
 */
export function SenderAvatar({
  email,
  name,
  className,
}: {
  email: string | null;
  name: string | null;
  className: string;
}) {
  const address = (email ?? "").trim().toLowerCase();
  const domain = address.includes("@") ? address.split("@")[1]! : "";

  const [state, setState] = useState<{ address: string; source: AvatarSource }>(() => ({
    address,
    source: firstSource(address),
  }));
  // Reset when this card is reused for a different sender (render-phase reset)
  if (state.address !== address) {
    setState({ address, source: firstSource(address) });
  }

  const handleError = () => {
    const source = nextSource(state.source, domain);
    sourceCache.set(address, source);
    setState({ address, source });
  };

  const handleLoad = () => {
    verifiedGravatars.add(address);
    sourceCache.set(address, state.source);
  };

  useEffect(() => {
    if (state.address !== address || state.source !== "gravatar" || verifiedGravatars.has(address)) return;
    let active = true;
    void checkGravatar(address).then((available) => {
      if (!active) return;
      if (available) {
        verifiedGravatars.add(address);
        setState((current) => current.address === address ? { ...current } : current);
      } else {
        const source = nextSource("gravatar", domain);
        sourceCache.set(address, source);
        setState({ address, source });
      }
    });
    return () => { active = false; };
  }, [address, domain, state.address, state.source]);

  const initial = (name?.[0] ?? email?.[0] ?? "?").toUpperCase();

  if (state.source === "gravatar" && verifiedGravatars.has(address)) {
    return (
      <div className={`${className} rounded-full overflow-hidden bg-bg-tertiary`}>
        <img
          src={getGravatarUrl(address)}
          alt=""
          loading="lazy"
          onError={handleError}
          onLoad={handleLoad}
          className="w-full h-full object-cover"
        />
      </div>
    );
  }

  if (state.source === "gravatar") {
    return (
      <div className={`${className} rounded-full overflow-hidden bg-bg-tertiary flex items-center justify-center font-medium text-white`}>
        {initial}
      </div>
    );
  }

  if (state.source === "favicon") {
    return (
      <div className={`${className} rounded-full overflow-hidden bg-white flex items-center justify-center`}>
        <img
          src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`}
          alt=""
          loading="lazy"
          onError={handleError}
          onLoad={handleLoad}
          className="w-[70%] h-[70%] object-contain"
        />
      </div>
    );
  }

  return (
    <div
      className={`${className} rounded-full flex items-center justify-center font-medium text-white bg-text-tertiary`}
    >
      {initial}
    </div>
  );
}
