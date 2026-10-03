import { useState } from "react";
import { Calendar, Loader2, Mail, Server } from "lucide-react";
import { startOAuthFlow } from "@/services/gmail/auth";
import { insertAccount } from "@/services/db/accounts";
import { getClientId, getClientSecret } from "@/services/gmail/tokenManager";
import { useAccountStore } from "@/stores/accountStore";
import { Modal } from "@/components/ui/Modal";
import { SetupClientId } from "./SetupClientId";
import { AddImapAccount, type ImapPreset } from "./AddImapAccount";
import { AddCalDavAccount } from "./AddCalDavAccount";
import { getCurrentUnixTimestamp } from "@/utils/timestamp";

import { Tooltip } from "@/components/ui/Tooltip";
interface AddAccountProps {
  onClose: () => void;
  onSuccess: () => void;
  /** Stacking context — raise it when opened from another overlay (e.g. settings) */
  zIndex?: string;
}

type View = "select-provider" | "imap" | "caldav";

/**
 * One-click providers. Picking one skips the "which server?" guesswork — the
 * IMAP wizard opens with that provider's servers and auth method already set.
 */
const IMAP_PRESETS: (ImapPreset & { initial: string; tint: string })[] = [
  { id: "outlook", name: "Outlook", domain: "outlook.com", initial: "O", tint: "text-[#0078d4]" },
  { id: "icloud", name: "iCloud", domain: "icloud.com", initial: "i", tint: "text-[#3b82f6]" },
  { id: "yahoo", name: "Yahoo", domain: "yahoo.com", initial: "Y", tint: "text-[#7e22ce]" },
  { id: "fastmail", name: "Fastmail", domain: "fastmail.com", initial: "F", tint: "text-[#0ea5e9]" },
  { id: "proton", name: "Proton", domain: "proton.me", initial: "P", tint: "text-[#8b5cf6]" },
  { id: "gmx", name: "GMX", domain: "gmx.com", initial: "G", tint: "text-[#f97316]" },
  { id: "zoho", name: "Zoho", domain: "zoho.com", initial: "Z", tint: "text-[#dc2626]" },
  { id: "aol", name: "AOL", domain: "aol.com", initial: "A", tint: "text-[#0ea5e9]" },
];

function GoogleLogo({ className = "w-5 h-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
    </svg>
  );
}

export function AddAccount({ onClose, onSuccess, zIndex }: AddAccountProps) {
  const [view, setView] = useState<View>("select-provider");
  const [imapPreset, setImapPreset] = useState<ImapPreset | null>(null);
  const [status, setStatus] = useState<
    "idle" | "checking" | "authenticating" | "error"
  >("idle");
  const [error, setError] = useState<string | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const addAccount = useAccountStore((s) => s.addAccount);

  const busy = status === "checking" || status === "authenticating";

  const handleAddGmailAccount = async () => {
    setStatus("checking");
    setError(null);

    try {
      const clientId = await getClientId();
      const clientSecret = await getClientSecret();
      setStatus("authenticating");

      const { tokens, userInfo } = await startOAuthFlow(clientId, clientSecret);

      const accountId = crypto.randomUUID();
      const expiresAt = getCurrentUnixTimestamp() + tokens.expires_in;

      await insertAccount({
        id: accountId,
        email: userInfo.email,
        displayName: userInfo.name,
        avatarUrl: userInfo.picture,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? "",
        tokenExpiresAt: expiresAt,
      });

      addAccount({
        id: accountId,
        email: userInfo.email,
        displayName: userInfo.name,
        avatarUrl: userInfo.picture,
        isActive: true,
      });

      onSuccess();
    } catch (err) {
      console.error("Add account error:", err);
      const message = err instanceof Error ? err.message : String(err);
      if (
        message.includes("Client ID not configured") ||
        message.includes("Client Secret is not configured")
      ) {
        setNeedsSetup(true);
        setStatus("idle");
      } else {
        setError(message);
        setStatus("error");
      }
    }
  };

  const openImap = (preset: ImapPreset | null) => {
    setImapPreset(preset);
    setView("imap");
  };

  const backToPicker = () => {
    setView("select-provider");
    setImapPreset(null);
    setStatus("idle");
    setError(null);
  };

  if (needsSetup) {
    return (
      <SetupClientId
        zIndex={zIndex}
        onComplete={() => {
          setNeedsSetup(false);
          setStatus("idle");
          // Credentials are in place — go straight back into the browser flow.
          void handleAddGmailAccount();
        }}
        onCancel={onClose}
      />
    );
  }

  if (view === "caldav") {
    return (
      <AddCalDavAccount
        zIndex={zIndex}
        onClose={onClose}
        onSuccess={onSuccess}
        onBack={backToPicker}
      />
    );
  }

  if (view === "imap") {
    return (
      <AddImapAccount
        zIndex={zIndex}
        preset={imapPreset}
        onClose={onClose}
        onSuccess={onSuccess}
        onBack={backToPicker}
      />
    );
  }

  return (
    <Modal
      isOpen={true}
      onClose={onClose}
      title="Add Account"
      width="w-full max-w-md"
      zIndex={zIndex}
    >
      <div className="p-4">
        {error && (
          <div className="bg-danger/10 border border-danger/20 rounded-lg p-3 mb-4 text-sm text-danger">
            {error}
          </div>
        )}

        {/* Google — one click straight into the browser OAuth flow */}
        <button
          onClick={handleAddGmailAccount}
          disabled={busy}
          className="w-full flex items-center gap-4 p-4 rounded-lg border border-border-primary bg-bg-secondary hover:bg-bg-hover transition-colors text-left group disabled:cursor-wait"
        >
          <div className="shrink-0 w-10 h-10 rounded-lg bg-bg-tertiary flex items-center justify-center">
            {busy ? (
              <Loader2 className="w-5 h-5 text-accent animate-spin" />
            ) : (
              <GoogleLogo />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-text-primary group-hover:text-accent transition-colors">
              Continue with Google
            </div>
            <div className="text-xs text-text-tertiary mt-0.5">
              {status === "checking" && "Opening your browser..."}
              {status === "authenticating" &&
                "Finish signing in in your browser, then come back here."}
              {!busy && "Gmail via OAuth — full Gmail API support"}
            </div>
          </div>
        </button>

        <div className="flex items-center gap-3 my-4">
          <div className="h-px flex-1 bg-border-primary" />
          <span className="text-[0.625rem] uppercase tracking-wider text-text-tertiary">
            or pick your provider
          </span>
          <div className="h-px flex-1 bg-border-primary" />
        </div>

        <div className="grid grid-cols-4 gap-2">
          {IMAP_PRESETS.map((preset) => (
            <Tooltip content={`Set up ${preset.name}`}><button
              key={preset.id}
              onClick={() =>
                openImap({ id: preset.id, name: preset.name, domain: preset.domain })
              }
              className="flex flex-col items-center gap-1.5 px-1 py-3 rounded-lg border border-border-primary bg-bg-secondary hover:bg-bg-hover hover:border-accent transition-colors"

            >
              <span
                className={`w-7 h-7 rounded-md bg-bg-tertiary flex items-center justify-center text-sm font-semibold ${preset.tint}`}
              >
                {preset.initial}
              </span>
              <span className="text-[0.6875rem] text-text-secondary truncate max-w-full">
                {preset.name}
              </span>
            </button></Tooltip>
          ))}
        </div>

        <div className="space-y-2 mt-4">
          <button
            onClick={() => openImap(null)}
            className="w-full flex items-center gap-3 p-3 rounded-lg border border-border-primary bg-bg-secondary hover:bg-bg-hover transition-colors text-left group"
          >
            <div className="shrink-0 w-8 h-8 rounded-lg bg-bg-tertiary flex items-center justify-center">
              <Server className="w-4 h-4 text-text-secondary" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-text-primary group-hover:text-accent transition-colors">
                Other mail account (IMAP/SMTP)
              </div>
              <div className="text-xs text-text-tertiary mt-0.5">
                Servers are detected from your address where possible
              </div>
            </div>
          </button>

          <button
            onClick={() => setView("caldav")}
            className="w-full flex items-center gap-3 p-3 rounded-lg border border-border-primary bg-bg-secondary hover:bg-bg-hover transition-colors text-left group"
          >
            <div className="shrink-0 w-8 h-8 rounded-lg bg-bg-tertiary flex items-center justify-center">
              <Calendar className="w-4 h-4 text-text-secondary" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-text-primary group-hover:text-accent transition-colors">
                CalDAV calendar only
              </div>
              <div className="text-xs text-text-tertiary mt-0.5">
                iCloud, Fastmail, Nextcloud — no mailbox
              </div>
            </div>
          </button>
        </div>

        <div className="flex items-center justify-between mt-4">
          <span className="flex items-center gap-1.5 text-xs text-text-tertiary">
            <Mail className="w-3.5 h-3.5" />
            Passwords are encrypted locally
          </span>
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}
