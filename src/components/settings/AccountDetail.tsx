import { useState, useEffect, useCallback } from "react";
import { ChevronLeft } from "lucide-react";
import { Tooltip } from "@/components/ui/Tooltip";
import { Spinner } from "@/components/ui/Spinner";
import { reportError, notify } from "@/stores/toastStore";
import { useAccountStore, type Account } from "@/stores/accountStore";
import { useUIStore } from "@/stores/uiStore";
import { useIdleStatusStore, describeIdleState, explainIdleFailure } from "@/stores/idleStatusStore";
import { ACCOUNT_COLORS, accountColor } from "@/constants/accountColors";
import { updateAccountColor, deleteAccount, getAccount } from "@/services/db/accounts";import { getSetting } from "@/services/db/settings";
import { removeClient, reauthorizeAccount } from "@/services/gmail/tokenManager";
import { resyncAccount } from "@/services/gmail/syncManager";
import {
  backgroundWorkerOwnsSync,
  reconfigureBackgroundWorkerRelay,
  requestWorkerResync,
} from "@/services/worker/workerClient";
import { listRelayProfiles, updateRelayAccounts } from "@/services/worker/relaySharing";
import { SendAsAliasesSection } from "./SendAsAliasesSection";
import { SignatureEditor } from "./SignatureEditor";
import { LabelEditor } from "./LabelEditor";
import { Section } from "./SettingsSection";

export const PROVIDER_LABELS: Record<string, string> = {
  gmail_api: "Gmail",
  imap: "IMAP",
  caldav: "CalDAV",
};

/** The relay grant created in Settings → Plugins ("Create Commonplace token"). */
const COMMONPLACE_PROFILE = "commonplace";

/**
 * Per-account settings: everything that belongs to one mailbox — aliases,
 * signatures, folders, calendar, sharing and account actions. Opened from
 * the accounts list in Settings → Accounts.
 */
export function AccountDetail({ account, onBack }: { account: Account; onBack: () => void }) {
  const accounts = useAccountStore((s) => s.accounts);
  const removeAccountFromStore = useAccountStore((s) => s.removeAccount);
  const isMailAccount = account.provider !== "caldav";
  const isImap = account.provider === "imap";
  const providerLabel = PROVIDER_LABELS[account.provider ?? ""] ?? account.provider ?? "Account";
  const colorIndex = Math.max(0, accounts.findIndex((a) => a.id === account.id));
  const [reauthStatus, setReauthStatus] = useState<"idle" | "authorizing" | "done" | "error">("idle");
  const [resyncStatus, setResyncStatus] = useState<"idle" | "syncing" | "done" | "error">("idle");
  const [reconnecting, setReconnecting] = useState(false);

  const handleReauthorize = useCallback(async () => {
    setReauthStatus("authorizing");
    try {
      await reauthorizeAccount(account.id, account.email);
      setReauthStatus("done");
      notify("success", `${account.email} re-authorised`, "Starting instant delivery with the new permissions.");
      // The new token carries the IMAP scope — use it now rather than
      // waiting for the next launch or a manual Reconnect
      try {
        const { reconnectAccount } = await import("@/services/imap/idleManager");
        await reconnectAccount(account.id);
      } catch (err) {
        reportError(`Could not start instant delivery for ${account.email}`, err);
      }
      setTimeout(() => setReauthStatus("idle"), 3000);
    } catch (err) {
      reportError(`Re-authorisation failed for ${account.email}`, err, {
        label: "Try again",
        run: () => void handleReauthorize(),
      });
      setReauthStatus("error");
      setTimeout(() => setReauthStatus("idle"), 3000);
    }
  }, [account.id, account.email]);

  const handleResync = useCallback(async () => {
    setResyncStatus("syncing");
    try {
      if (backgroundWorkerOwnsSync()) await requestWorkerResync([account.id]);
      else await resyncAccount(account.id);
      setResyncStatus("done");
      setTimeout(() => setResyncStatus("idle"), 3000);
    } catch (err) {
      reportError("Resync failed", err);
      setResyncStatus("error");
      setTimeout(() => setResyncStatus("idle"), 3000);
    }
  }, [account.id]);

  const handleRemove = useCallback(async () => {
    removeClient(account.id);
    await deleteAccount(account.id);
    removeAccountFromStore(account.id);
    if (backgroundWorkerOwnsSync()) {
      void reconfigureBackgroundWorkerRelay().catch((error) =>
        console.warn("Could not refresh background worker account configuration:", error),
      );
    }
    notify("success", `${account.email} removed`);
    onBack();
  }, [account.id, account.email, onBack, removeAccountFromStore]);

  return (
    <div className="space-y-6">
      <div>
        <button
          onClick={onBack}
          className="flex items-center gap-1 text-xs text-accent hover:text-accent-hover transition-colors mb-2"
        >
          <ChevronLeft size={14} />
          All accounts
        </button>
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-text-primary truncate">
            {account.displayName ?? account.email}
          </h2>
          <span className="text-[0.6rem] font-medium px-1.5 py-0.5 rounded-full bg-bg-tertiary text-text-tertiary">
            {providerLabel}
          </span>
        </div>
        <div className="text-xs text-text-tertiary truncate">{account.email}</div>
      </div>

      {isMailAccount && <SendAsAliasesSection accountId={account.id} />}

      {isMailAccount && (
        <Section title="Signatures">
          <SignatureEditor accountId={account.id} />
        </Section>
      )}

      {isMailAccount && (
        <Section title="Folders & labels">
          <LabelEditor accountId={account.id} />
        </Section>
      )}

      {isImap && (
        <Section title="Calendar (CalDAV)">
          <CalDavSettingsInline accountId={account.id} />
        </Section>
      )}

      <AccountSharingSection accountId={account.id} />

      <Section title="Identity">
        <AccountColorPicker accountId={account.id} selectedId={accountColor(account.color, colorIndex).id} />
      </Section>

      <Section title="Account actions">
        <AccountActions
          account={account}
          reauthStatus={reauthStatus}
          resyncStatus={resyncStatus}
          reconnecting={reconnecting}
          setReconnecting={setReconnecting}
          onReauthorize={() => void handleReauthorize()}
          onResync={() => void handleResync()}
          onRemove={() => void handleRemove()}
        />
      </Section>
    </div>
  );
}

function AccountActions({
  account,
  reauthStatus,
  resyncStatus,
  reconnecting,
  setReconnecting,
  onReauthorize,
  onResync,
  onRemove,
}: {
  account: Account;
  reauthStatus: "idle" | "authorizing" | "done" | "error";
  resyncStatus: "idle" | "syncing" | "done" | "error";
  reconnecting: boolean;
  setReconnecting: (busy: boolean) => void;
  onReauthorize: () => void;
  onResync: () => void;
  onRemove: () => void;
}) {
  // The same setting the Instant delivery toggle writes; read it here so the
  // status line shows only when a push connection is actually wanted.
  const [imapIdle, setImapIdle] = useState(true);
  useEffect(() => {
    getSetting("imap_idle").then((value) => setImapIdle(value !== "false"));
  }, []);

  return (
    <div className="space-y-3">
      <IdleStatusLine accountId={account.id} imapIdle={imapIdle} />
      <div className="flex items-center gap-3 flex-wrap">
        {account.provider !== "caldav" && (
          <button
            onClick={async () => {
              setReconnecting(true);
              try {
                const { reconnectAccount } = await import("@/services/imap/idleManager");
                await reconnectAccount(account.id);
              } finally {
                setReconnecting(false);
              }
            }}
            disabled={reconnecting}
            className="flex items-center gap-1 text-xs text-accent hover:text-accent-hover transition-colors disabled:opacity-50"
          >
            {reconnecting && <Spinner size={11} label="Reconnecting" />}
            Reconnect
          </button>
        )}
        <Tooltip
          content={
            reauthStatus === "authorizing"
              ? "Waiting for the sign-in to finish in your browser. If the tab is gone, click again to start over."
              : "Sign in again to grant new permissions — needed once for instant delivery and for managing send-as aliases."
          }
          placement="bottom"
        >
          <button
            onClick={onReauthorize}
            className="flex items-center gap-1 text-xs text-accent hover:text-accent-hover transition-colors"
          >
            {reauthStatus === "authorizing" && <><Spinner size={11} label="Waiting for Google" />Waiting…</>}
            {reauthStatus === "done" && "Done!"}
            {reauthStatus === "error" && "Failed"}
            {(reauthStatus === "idle") && "Re-authorize"}
          </button>
        </Tooltip>
        <button
          onClick={onResync}
          disabled={resyncStatus === "syncing"}
          className="flex items-center gap-1 text-xs text-accent hover:text-accent-hover transition-colors disabled:opacity-50"
        >
          {resyncStatus === "syncing" && <><Spinner size={11} label="Resyncing" />Resyncing…</>}
          {resyncStatus === "done" && "Done!"}
          {resyncStatus === "error" && "Failed"}
          {(resyncStatus === "idle") && "Resync"}
        </button>
        <button
          onClick={onRemove}
          className="text-xs text-danger hover:text-danger/80 transition-colors"
        >
          Remove
        </button>
      </div>
    </div>
  );
}

function IdleStatusLine({ accountId, imapIdle }: { accountId: string; imapIdle: boolean }) {
  const idleStatuses = useIdleStatusStore((s) => s.statuses);
  const idleReasons = useIdleStatusStore((s) => s.reasons);
  if (!imapIdle) return null;
  const state = idleStatuses[accountId] ?? "off";
  const reason = idleReasons[accountId];
  const explanation =
    state === "connected"
      ? "The server is holding a connection open and will say the moment mail arrives."
      : state === "connecting"
        ? "Asking the server to hold a connection. Usually a few seconds."
        : state === "failed"
          ? explainIdleFailure(reason)
          : "Not being watched. This account still syncs on the timer.";
  return (
    <Tooltip content={explanation} placement="bottom">
      <div className="flex items-center gap-1.5 text-[0.6875rem] cursor-default w-fit">
        {state === "connecting" ? (
          <Spinner size={11} label="Connecting" className="text-accent" />
        ) : (
          <span
            aria-hidden="true"
            className={`inline-block w-2 h-2 rounded-full ${
              state === "connected" ? "bg-success"
              : state === "failed" ? "bg-warning"
              : "bg-text-tertiary"
            }`}
          />
        )}
        <span className={
          state === "connected" ? "text-success"
          : state === "failed" ? "text-warning"
          : "text-text-tertiary"
        }>
          {describeIdleState(state)}
        </span>
      </div>
    </Tooltip>
  );
}

export function AccountColorPicker({
  accountId,
  selectedId,
}: {
  accountId: string;
  selectedId: string;
}) {
  const setAccountColor = useAccountStore((s) => s.setAccountColor);

  const pick = async (colorId: string) => {
    setAccountColor(accountId, colorId);
    await updateAccountColor(accountId, colorId);
  };

  return (
    <div className="flex items-center gap-1.5">
      {ACCOUNT_COLORS.map((color) => {
        const isSelected = color.id === selectedId;
        return (
          <Tooltip key={color.id} content={color.label}><button
            onClick={() => pick(color.id)}
            aria-label={`Use ${color.label} for this account`}
            aria-pressed={isSelected}
            className={`w-4 h-4 rounded-full transition-transform hover:scale-110 ${
              isSelected ? "ring-2 ring-offset-2 ring-offset-bg-secondary ring-text-tertiary" : ""
            }`}
            style={{ backgroundColor: color.hex }}
          /></Tooltip>
        );
      })}
    </div>
  );
}

/**
 * Whether this mailbox is included in the Commonplace relay grant. The
 * bearer token is created once in Settings → Plugins; toggling here only
 * changes which accounts the grant covers, never the token. Clearing the
 * last account revokes the grant entirely.
 */
function AccountSharingSection({ accountId }: { accountId: string }) {
  const setSettingsTab = useUIStore((s) => s.setSettingsTab);
  const [granted, setGranted] = useState(false);
  const [profileExists, setProfileExists] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const profiles = await listRelayProfiles();
        const profile = profiles.find((p) => p.profileId === COMMONPLACE_PROFILE);
        if (cancelled) return;
        setProfileExists(!!profile);
        setGranted(!!profile && profile.accountIds.includes(accountId));
      } catch {
        if (!cancelled) setProfileExists(false);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  const toggle = async (next: boolean) => {
    setBusy(true);
    try {
      const profiles = await listRelayProfiles();
      const profile = profiles.find((p) => p.profileId === COMMONPLACE_PROFILE);
      if (!profile) return;
      const accountIds = new Set(profile.accountIds);
      if (next) accountIds.add(accountId);
      else accountIds.delete(accountId);
      await updateRelayAccounts(COMMONPLACE_PROFILE, [...accountIds]);
      setGranted(next);
    } catch (error) {
      reportError("Could not update Commonplace sharing", error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Sharing">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm text-text-secondary">Shared with Commonplace</div>
          <p className="text-xs text-text-tertiary mt-0.5">
            {profileExists
              ? "Include this mailbox in the local Commonplace relay grant. Toggling never changes the token, only which accounts it covers."
              : "No Commonplace grant exists yet. Create the access token in Settings → Plugins first, then decide here which mailboxes it covers."}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1.5 shrink-0">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={granted}
              disabled={busy || !loaded || !profileExists}
              onChange={(e) => void toggle(e.target.checked)}
              aria-label="Shared with Commonplace"
            />
            <span className="text-xs text-text-tertiary">{granted ? "Shared" : "Not shared"}</span>
          </label>
          <button
            type="button"
            onClick={() => setSettingsTab("plugins")}
            className="text-xs text-accent hover:text-accent-hover transition-colors"
          >
            Manage in Plugins
          </button>
        </div>
      </div>
    </Section>
  );
}

function CalDavSettingsInline({ accountId }: { accountId: string }) {
  const [CalDav, setCalDav] = useState<typeof import("@/components/settings/CalDavSettings").CalDavSettings | null>(null);
  const [account, setAccount] = useState<import("@/services/db/accounts").DbAccount | null>(null);

  useEffect(() => {
    import("@/components/settings/CalDavSettings").then((m) => setCalDav(() => m.CalDavSettings));
  }, []);

  const reload = useCallback(() => {
    getAccount(accountId).then(setAccount);
  }, [accountId]);

  useEffect(() => {
    reload();
  }, [reload]);

  if (!account || !CalDav) return <div className="text-xs text-text-tertiary">Loading...</div>;

  return <CalDav account={account} onSaved={reload} />;
}
