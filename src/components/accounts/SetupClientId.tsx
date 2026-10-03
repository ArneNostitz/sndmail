import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { setSetting, setSecureSetting } from "@/services/db/settings";
import { validateClientId, validateClientSecret } from "@/services/gmail/clientCredentials";
import { Modal } from "@/components/ui/Modal";

import { Tooltip } from "@/components/ui/Tooltip";
const CREDENTIALS_URL = "https://console.cloud.google.com/apis/credentials";
const REDIRECT_URI = "http://127.0.0.1:17248";

interface SetupClientIdProps {
  onComplete: () => void;
  onCancel: () => void;
  /** Stacking context — raise it when opened from another overlay */
  zIndex?: string;
}

export function SetupClientId({ onComplete, onCancel, zIndex }: SetupClientIdProps) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  // Only complain once there is something to complain about
  const idError = clientId.trim() ? validateClientId(clientId) : null;
  const secretError = clientSecret.trim() ? validateClientSecret(clientSecret) : null;
  const canSave = !!clientId.trim() && !!clientSecret.trim() && !idError && !secretError;

  const handleSave = async () => {
    const trimmedId = clientId.trim();
    const trimmedSecret = clientSecret.trim();
    if (!canSave) return;

    setSaving(true);
    try {
      await setSetting("google_client_id", trimmedId);
      await setSecureSetting("google_client_secret", trimmedSecret);
      onComplete();
    } catch {
      setSaving(false);
    }
  };

  const handleCopyRedirect = async () => {
    try {
      await navigator.clipboard.writeText(REDIRECT_URI);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable — the URI is visible on screen anyway
    }
  };

  return (
    <Modal
      isOpen={true}
      onClose={onCancel}
      title="Google API Setup"
      width="w-full max-w-lg"
      zIndex={zIndex}
    >
      <div className="p-4">
        <p className="text-text-secondary text-sm mb-4">
          Gmail sign-in uses your own Google Cloud OAuth credentials. This is a
          one-time setup — every Google account you add afterwards is a single click.
        </p>

        <button
          onClick={() => openUrl(CREDENTIALS_URL)}
          className="w-full flex items-center justify-center gap-2 px-4 py-2 mb-4 text-sm bg-bg-secondary border border-border-primary rounded-lg text-text-primary hover:bg-bg-hover hover:border-accent transition-colors"
        >
          <ExternalLink className="w-3.5 h-3.5" />
          Open Google Cloud credentials
        </button>

        <ol className="text-text-secondary text-sm mb-4 space-y-1 list-decimal list-inside">
          <li>Create a project (or use an existing one)</li>
          <li>Enable the Gmail API</li>
          <li>Create OAuth 2.0 credentials (Web application type)</li>
          <li className="flex flex-wrap items-center gap-1">
            <span>Add this authorized redirect URI:</span>
            <Tooltip content="Copy to clipboard"><button
              onClick={handleCopyRedirect}

              className="bg-bg-tertiary px-1.5 py-0.5 rounded text-xs font-mono text-text-primary hover:text-accent transition-colors"
            >
              {copied ? "Copied!" : REDIRECT_URI}
            </button></Tooltip>
          </li>
          <li>Copy the Client ID and Client Secret below</li>
        </ol>

        <input
          type="text"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          placeholder="Paste your Client ID here..."
          className={`w-full px-3 py-2 bg-bg-secondary border rounded-lg text-sm outline-none focus:border-accent ${
            idError ? "border-danger mb-1" : "border-border-primary mb-3"
          }`}
        />
        {idError && <p className="text-danger text-xs mb-3">{idError}</p>}

        <input
          type="password"
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          placeholder="Paste your Client Secret here..."
          className={`w-full px-3 py-2 bg-bg-secondary border rounded-lg text-sm mb-1 outline-none focus:border-accent ${
            secretError ? "border-danger" : "border-border-primary"
          }`}
        />
        <p className={`text-xs mb-4 ${secretError ? "text-danger" : "text-text-tertiary"}`}>
          {secretError ?? "Required for Web application credentials"}
        </p>

        <div className="flex gap-3 justify-end">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!canSave || saving}
            className="px-4 py-2 text-sm bg-accent text-white rounded-lg hover:bg-accent-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? "Saving..." : "Save & Continue"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
