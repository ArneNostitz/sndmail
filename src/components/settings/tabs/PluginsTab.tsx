import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/Button";
import { useAccountStore } from "@/stores/accountStore";
import { notify, reportError } from "@/stores/toastStore";
import { Section } from "../SettingsSection";
import { SettingRow } from "../SettingRow";
import { ToggleRow } from "../ToggleRow";

/** Local integrations and the access they are granted. */
export function PluginsTab() {
  const accounts = useAccountStore((s) => s.accounts);
  const [relayAccountIds, setRelayAccountIds] = useState<Set<string>>(() => new Set());
  const [relayReadContent, setRelayReadContent] = useState(false);
  const [relayToken, setRelayToken] = useState("");

  const handleRelayGrant = useCallback(async () => {
    if (relayAccountIds.size === 0) return;
    try {
      const token = await invoke<string>("worker_create_relay_profile", {
        profileId: "commonplace",
        accountIds: [...relayAccountIds],
        readContent: relayReadContent,
      });
      setRelayToken(token);
    } catch (error) {
      reportError("Could not grant Commonplace mail access", error);
    }
  }, [relayAccountIds, relayReadContent]);

  const toggleRelayAccount = useCallback((accountId: string) => {
    setRelayAccountIds((prev) => {
      const next = new Set(prev);
      if (next.has(accountId)) next.delete(accountId);
      else next.add(accountId);
      return next;
    });
  }, []);

  const handleRelayRevoke = useCallback(async () => {
    try {
      await invoke("worker_revoke_relay_profile", { profileId: "commonplace" });
      setRelayToken("");
      notify("success", "Commonplace mail access revoked");
    } catch (error) {
      reportError("Could not revoke Commonplace mail access", error);
    }
  }, []);

  const mailAccounts = accounts.filter((account) => account.provider !== "caldav");

  return (
    <>
      <p className="text-sm text-text-secondary">
        Local integrations. Each plugin runs on your machine and only gets the access you grant it here.
      </p>
      <Section title="Commonplace">
        <p className="text-sm text-text-secondary">
          Grant Commonplace local read access to your sndmail mailboxes. The token is shown once; creating a new one replaces the old grant.
        </p>
        <SettingRow label="Shared inboxes">
          <div className="space-y-1.5">
            {mailAccounts.map((account) => (
              <label key={account.id} className="flex items-center gap-2 text-sm text-text-primary">
                <input
                  type="checkbox"
                  checked={relayAccountIds.has(account.id)}
                  onChange={() => toggleRelayAccount(account.id)}
                  className="accent-accent"
                  aria-label={`Share ${account.email} with Commonplace`}
                />
                {account.email}
              </label>
            ))}
            {mailAccounts.length === 0 && (
              <p className="text-sm text-text-tertiary">Add a mail account first.</p>
            )}
          </div>
        </SettingRow>
        <ToggleRow
          label="Allow message content"
          description="Off by default. Metadata access never includes subjects, snippets, bodies, credentials, or login codes."
          checked={relayReadContent}
          onToggle={() => setRelayReadContent(!relayReadContent)}
        />
        <div className="flex gap-2">
          <Button variant="secondary" size="md" onClick={handleRelayGrant} disabled={relayAccountIds.size === 0}>Create access token</Button>
          <Button variant="secondary" size="md" onClick={handleRelayRevoke}>Revoke access</Button>
        </div>
        {relayToken && (
          <SettingRow label="Copy this token now">
            <input
              readOnly
              value={relayToken}
              onFocus={(event) => event.currentTarget.select()}
              className="w-80 bg-bg-tertiary text-text-primary text-xs px-3 py-1.5 rounded-md border border-border-primary"
              aria-label="Commonplace mail relay access token"
            />
          </SettingRow>
        )}
      </Section>
    </>
  );
}
