import { useMemo, useState } from "react";
import { Copy, Check, ExternalLink, KeyRound } from "lucide-react";
import { detectOtpCode, detectSignInLink } from "@/utils/otpDetector";
import { reportError } from "@/stores/toastStore";
import type { DbMessage } from "@/services/db/messages";

/**
 * The code and the sign-in link of a login mail, as buttons on the message.
 *
 * Desktop notifications cannot carry buttons, so this is where they live for
 * good: open the mail and the code is one click to copy and the link one
 * click to open, without hunting through the body for either.
 */
export function OneTimeCodeBanner({ message }: { message: DbMessage }) {
  const found = useMemo(() => {
    const text = message.body_text ?? stripTags(message.body_html);
    return {
      code: detectOtpCode(message.subject, text)?.code ?? null,
      link: detectSignInLink(message.body_html)?.url ?? null,
    };
  }, [message.subject, message.body_text, message.body_html]);
  const [copied, setCopied] = useState(false);

  if (!found.code && !found.link) return null;

  const copy = async () => {
    if (!found.code) return;
    try {
      const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
      await writeText(found.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      reportError("Could not copy the code", err);
    }
  };

  const open = () => {
    if (!found.link) return;
    window.dispatchEvent(new CustomEvent("sndmail-open-signin-link", {
      detail: { url: found.link, threadId: message.thread_id, accountId: message.account_id },
    }));
  };

  return (
    <div className="flex items-center gap-2 mb-3 px-3 py-2 rounded-lg bg-accent/8 border border-accent/20 text-sm">
      <KeyRound size={14} className="text-accent shrink-0" />
      {found.code && (
        <>
          <span className="font-mono font-semibold tracking-widest text-text-primary">{found.code}</span>
          <button
            onClick={copy}
            className="flex items-center gap-1 text-xs font-medium text-accent hover:underline"
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? "Copied" : "Copy code"}
          </button>
        </>
      )}
      {found.link && (
        <button
          onClick={open}
          className="flex items-center gap-1 text-xs font-medium text-accent hover:underline ml-auto"
        >
          <ExternalLink size={12} />
          Open sign-in link
        </button>
      )}
    </div>
  );
}

function stripTags(html: string | null): string | null {
  if (!html) return null;
  try {
    return new DOMParser().parseFromString(html, "text/html").body?.textContent ?? null;
  } catch {
    return null;
  }
}
