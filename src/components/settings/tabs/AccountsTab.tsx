import { useCallback, useEffect, useState } from "react";
import { ChevronRight, Mail, Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";
import { useUIStore } from "@/stores/uiStore";
import { useAccountStore } from "@/stores/accountStore";
import { reportError } from "@/stores/toastStore";
import { accountColor } from "@/constants/accountColors";
import { getSetting, getSecureSetting, setSecureSetting, setSetting } from "@/services/db/settings";
import { validateClientId, validateClientSecret } from "@/services/gmail/clientCredentials";
import { forceFullSync, triggerSync } from "@/services/gmail/syncManager";
import {
  backgroundWorkerOwnsSync,
  requestWorkerResync,
  wakeBackgroundWorkerAndWait,
} from "@/services/worker/workerClient";
import { refreshAfterAccountAdded } from "@/services/accounts/accountLifecycle";
import { AddAccount } from "@/components/accounts/AddAccount";
import { Section } from "../SettingsSection";
import { SettingRow } from "../SettingRow";
import { SelectField } from "../SelectField";
import { ToggleRow } from "../ToggleRow";
import { AccountDetail, PROVIDER_LABELS } from "../AccountDetail";
import { GmailPushRelaySection } from "../GmailPushRelaySection";
import { SyncOfflineSection } from "../SyncOfflineSection";

/**
 * The account list, and — once a row is picked — that account's detail pane.
 * The Google API key, instant delivery and sync settings belong to the list
 * level because they are not about one mailbox.
 */
export function AccountsTab() {
  const accounts = useAccountStore((s) => s.accounts);
  const addAccountPending = useUIStore((s) => s.settingsAddAccountPending);
  const clearAddAccountRequest = useUIStore((s) => s.clearAddAccountRequest);
  // Master–detail: the accounts list opens a per-account detail pane
  const [detailAccountId, setDetailAccountId] = useState<string | null>(null);
  const detailAccount = accounts.find((a) => a.id === detailAccountId) ?? null;
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [imapIdle, setImapIdle] = useState(true);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [apiSettingsSaved, setApiSettingsSaved] = useState(false);
  const [syncOperation, setSyncOperation] = useState<"sync" | "resync" | null>(null);
  const [syncPeriodDays, setSyncPeriodDays] = useState("365");
  const isSyncing = syncOperation !== null;
  const clientIdError = clientId.trim() ? validateClientId(clientId) : null;
  const clientSecretError = clientSecret.trim() ? validateClientSecret(clientSecret) : null;

  // Something outside settings (command palette, sidebar) asked to add an account
  useEffect(() => {
    if (!addAccountPending) return;
    setShowAddAccount(true);
    clearAddAccountRequest();
  }, [addAccountPending, clearAddAccountRequest]);

  useEffect(() => {
    async function load() {
      setImapIdle((await getSetting("imap_idle")) !== "false");
      setClientId((await getSetting("google_client_id")) ?? "");
      setClientSecret((await getSecureSetting("google_client_secret")) ?? "");
      setSyncPeriodDays((await getSetting("sync_period_days")) ?? "365");
    }
    load();
  }, []);

  const handleSaveApiSettings = useCallback(async () => {
    const trimmedId = clientId.trim();
    const trimmedSecret = clientSecret.trim();
    // Never persist swapped credentials — Google only reports that as
    // `invalid_client` on its own page, after the browser is already open.
    if (trimmedId && validateClientId(trimmedId)) return;
    if (trimmedSecret && validateClientSecret(trimmedSecret)) return;
    if (trimmedId) {
      await setSetting("google_client_id", trimmedId);
    }
    if (trimmedSecret) {
      await setSecureSetting("google_client_secret", trimmedSecret);
    }
    setApiSettingsSaved(true);
    setTimeout(() => setApiSettingsSaved(false), 2000);
  }, [clientId, clientSecret]);

  const handleManualSync = useCallback(async () => {
    const activeIds = accounts.filter((a) => a.isActive).map((a) => a.id);
    if (activeIds.length === 0) return;
    setSyncOperation("sync");
    try {
      if (backgroundWorkerOwnsSync()) await wakeBackgroundWorkerAndWait(activeIds);
      else await triggerSync(activeIds);
    } catch (error) {
      reportError("Could not sync mail", error);
    } finally {
      setSyncOperation(null);
    }
  }, [accounts]);

  const handleForceFullSync = useCallback(async () => {
    const activeIds = accounts.filter((a) => a.isActive).map((a) => a.id);
    if (activeIds.length === 0) return;
    setSyncOperation("resync");
    try {
      if (backgroundWorkerOwnsSync()) await requestWorkerResync(activeIds);
      else await forceFullSync(activeIds);
    } catch (error) {
      reportError("Full resync failed", error);
    } finally {
      setSyncOperation(null);
    }
  }, [accounts]);

  if (detailAccount) {
    return <AccountDetail account={detailAccount} onBack={() => setDetailAccountId(null)} />;
  }

  return (
    <>
      <Section
        title="Accounts"
        action={
          <Button
            variant="secondary"
            size="sm"
            icon={<Plus size={14} />}
            onClick={() => setShowAddAccount(true)}
          >
            Add account
          </Button>
        }
      >
        {accounts.length === 0 ? (
          <button
            onClick={() => setShowAddAccount(true)}
            className="w-full flex flex-col items-center gap-2 px-4 py-8 rounded-lg border border-dashed border-border-primary text-center hover:border-accent hover:bg-bg-hover transition-colors"
          >
            <Mail className="w-6 h-6 text-text-tertiary" />
            <span className="text-sm font-medium text-text-primary">
              Connect your first mailbox
            </span>
            <span className="text-xs text-text-tertiary">
              Sign in with Google, or set up any IMAP/SMTP provider
            </span>
          </button>
        ) : (
          <div className="space-y-2">
            {accounts.map((account, accountIndex) => {
              const providerLabel = PROVIDER_LABELS[account.provider ?? ""] ?? "Account";
              const current = accountColor(account.color, accountIndex);
              return (
                <button
                  key={account.id}
                  onClick={() => setDetailAccountId(account.id)}
                  className="w-full flex items-center gap-3 py-2.5 px-4 bg-bg-secondary rounded-lg text-left hover:bg-bg-hover transition-colors group"
                >
                  <span
                    className="w-2.5 h-2.5 rounded-full shrink-0"
                    style={{ backgroundColor: current.hex }}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="text-sm font-medium text-text-primary flex items-center gap-2">
                      {account.displayName ?? account.email}
                      <span className="text-[0.6rem] font-medium px-1.5 py-0.5 rounded-full bg-bg-tertiary text-text-tertiary">
                        {providerLabel}
                      </span>
                    </span>
                    <span className="block text-xs text-text-tertiary truncate">
                      {account.email}
                    </span>
                  </span>
                  <ChevronRight
                    size={15}
                    className="text-text-tertiary shrink-0 group-hover:text-text-secondary"
                  />
                </button>
              );
            })}
          </div>
        )}
        <p className="text-xs text-text-tertiary">
          Select an account to manage its aliases, signatures, folders, calendar and sharing.
        </p>
      </Section>

      <Section title="Instant delivery">
        <ToggleRow
          label="Let servers push new mail"
          description="Hold a connection open so the server says the moment something arrives, instead of being asked every minute. Falls back to the timer wherever a server refuses. Status is shown in each account's detail."
          checked={imapIdle}
          onToggle={async () => {
            const next = !imapIdle;
            setImapIdle(next);
            await setSetting("imap_idle", next ? "true" : "false");
            const { startIdleWatchers, stopIdleWatchers } =
              await import("@/services/imap/idleManager");
            if (next) await startIdleWatchers();
            else await stopIdleWatchers();
          }}
        />
      </Section>

      <Section title="Google API">
        <div className="space-y-3">
          <TextField
            label="Client ID"
            size="md"
            type="text"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="1234567890-abc.apps.googleusercontent.com"
            {...(clientIdError ? { error: clientIdError } : {})}
          />
          <TextField
            label="Client Secret"
            size="md"
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder="GOCSPX-..."
            {...(clientSecretError ? { error: clientSecretError } : {})}
          />
          <Button
            variant="primary"
            size="md"
            onClick={handleSaveApiSettings}
            disabled={!clientId.trim() || !!clientIdError || !!clientSecretError}
          >
            {apiSettingsSaved ? "Saved!" : "Save"}
          </Button>
        </div>
      </Section>

      <GmailPushRelaySection />

      <Section title="Sync">
        <div className="flex items-center justify-between">
          <span className="text-sm text-text-secondary">
            Check for new mail
          </span>
          <Button
            variant="primary"
            size="md"
            icon={<RefreshCw size={14} className={isSyncing ? "animate-spin" : ""} />}
            onClick={handleManualSync}
            disabled={isSyncing || accounts.length === 0}
          >
            {syncOperation === "sync" ? "Checking mail..." : "Sync now"}
          </Button>
        </div>
        <div className="flex items-center justify-between">
          <div>
            <span className="text-sm text-text-secondary">
              Full resync
            </span>
            <p className="text-xs text-text-tertiary mt-0.5">
              Re-download all emails from scratch
            </p>
          </div>
          <Button
            variant="secondary"
            size="md"
            icon={<RefreshCw size={14} className={isSyncing ? "animate-spin" : ""} />}
            onClick={handleForceFullSync}
            disabled={isSyncing || accounts.length === 0}
            className="bg-bg-tertiary text-text-primary border border-border-primary"
          >
            {syncOperation === "resync" ? "Re-syncing..." : "Full resync"}
          </Button>
        </div>
      </Section>

      <Section title="Sync Period">
        <SettingRow label="Sync emails from">
          <SelectField
            value={syncPeriodDays}
            options={[
              { value: "30", label: "Last 30 days" },
              { value: "90", label: "Last 90 days" },
              { value: "180", label: "Last 180 days" },
              { value: "365", label: "Last 1 year" },
            ]}
            onChange={async (val) => {
              setSyncPeriodDays(val);
              await setSetting("sync_period_days", val);
            }}
          />
        </SettingRow>
        <p className="text-xs text-text-tertiary">
          Changes apply on the next full resync.
        </p>
      </Section>

      <SyncOfflineSection />

      {showAddAccount && (
        <AddAccount
          zIndex="z-[60]"
          onClose={() => setShowAddAccount(false)}
          onSuccess={async () => {
            setShowAddAccount(false);
            await refreshAfterAccountAdded();
          }}
        />
      )}
    </>
  );
}
