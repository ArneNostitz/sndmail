import { useState, useEffect, useCallback } from "react";
import { RefreshCw, Mail } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { reportError, notify } from "@/stores/toastStore";
import { useAccountStore } from "@/stores/accountStore";
import { getGmailClient, reauthorizeAccount } from "@/services/gmail/tokenManager";
import { fetchSendAsAliases } from "@/services/gmail/sendAs";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  getAliasesForAccount,
  getAllAliases,
  setDefaultAlias,
  mapDbAlias,
  upsertAlias,
  deleteAlias,
  type SendAsAlias,
} from "@/services/db/sendAsAliases";
import { collectOwnAddresses } from "@/services/accounts/ownAddresses";
import {
  findAliasSuggestions,
  type AliasSuggestion,
} from "@/services/accounts/aliasSuggestions";
import { Section } from "./SettingsSection";

/**
 * Send-as aliases for ONE account (the account whose detail pane this sits
 * in). The same address may be connected to several accounts: rows and
 * suggestions say where else it is already connected, so it can be added to
 * any account explicitly.
 */
export function SendAsAliasesSection({ accountId }: { accountId: string }) {
  const accounts = useAccountStore((s) => s.accounts);
  const account = accounts.find((a) => a.id === accountId) ?? null;
  const [aliases, setAliases] = useState<SendAsAlias[]>([]);
  const [suggestions, setSuggestions] = useState<AliasSuggestion[]>([]);
  const [elsewhere, setElsewhere] = useState<Map<string, string[]>>(new Map());
  const [newAliasEmail, setNewAliasEmail] = useState("");
  const [aliasBusy, setAliasBusy] = useState(false);
  const [aliasError, setAliasError] = useState<string | null>(null);
  const [needsReauth, setNeedsReauth] = useState(false);
  const [reauthBusy, setReauthBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const isMailAccount = !!account && account.provider !== "caldav";
  const isGmail = account?.provider === "gmail_api";

  const reload = useCallback(async () => {
    const dbAliases = await getAliasesForAccount(accountId);
    setAliases(dbAliases.map(mapDbAlias));
    // Where else each address is connected — one alias can belong to
    // several accounts, and each account decides its own list
    try {
      const all = await getAllAliases();
      const byEmail = new Map<string, string[]>();
      for (const row of all) {
        if (row.account_id === accountId) continue;
        const owner = accounts.find((a) => a.id === row.account_id);
        const name = owner?.displayName ?? owner?.email ?? row.account_id;
        const key = row.email.toLowerCase();
        const list = byEmail.get(key) ?? [];
        if (!list.includes(name)) list.push(name);
        byEmail.set(key, list);
      }
      setElsewhere(byEmail);
    } catch {
      setElsewhere(new Map());
    }
    const own = await collectOwnAddresses(useAccountStore.getState().accounts, [accountId]);
    setSuggestions(await findAliasSuggestions(accountId, own));
  }, [accountId, accounts]);

  useEffect(() => {
    if (!isMailAccount) {
      setAliases([]);
      setSuggestions([]);
      setElsewhere(new Map());
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        await reload();
      } catch {
        // Suggested aliases are optional decoration; the stored list is the truth.
        if (!cancelled) setSuggestions([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isMailAccount, reload]);

  const handleRefresh = async () => {
    if (!account || !isGmail) return;
    setRefreshing(true);
    setLoadError(null);
    try {
      const client = await getGmailClient(account.id);
      await fetchSendAsAliases(client, account.id);
      await reload();
      notify("success", "Aliases refreshed");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLoadError(message);
      if (isAuthRefusal(message)) setNeedsReauth(true);
      reportError("Could not refresh Gmail aliases", error);
    } finally {
      setRefreshing(false);
    }
  };

  const handleAddAlias = async (email: string): Promise<boolean> => {
    if (!account || !isMailAccount || isGmail) return false;
    const normalized = email.trim().toLowerCase();
    if (!normalized.includes("@") || normalized.split("@").some((part) => !part.trim())) {
      setAliasError("Enter a full email address, e.g. hello@reimedy.com.");
      return false;
    }
    if (aliases.some((a) => a.email.toLowerCase() === normalized)) {
      setAliasError("That address is already listed.");
      return false;
    }
    setAliasBusy(true);
    setAliasError(null);
    try {
      await upsertAlias({ accountId: account.id, email: normalized });
      await reload();
      notify("success", `Alias ${normalized} added`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setAliasError(message);
      reportError("Could not add alias", error);
      return false;
    } finally {
      setAliasBusy(false);
    }
  };

  const handleRemoveAlias = async (alias: SendAsAlias) => {
    if (!account || alias.isPrimary || isGmail) return;
    setAliasBusy(true);
    try {
      await deleteAlias(alias.id);
      await reload();
      notify("success", "Alias removed");
    } catch (error) {
      reportError("Could not remove alias", error);
    } finally {
      setAliasBusy(false);
    }
  };

  const handleOpenGmailSettings = async () => {
    if (!account) return;
    try {
      await openUrl("https://mail.google.com/mail/u/0/#settings/accounts");
    } catch (error) {
      reportError("Could not open Gmail settings", error);
    }
  };

  const handleSetDefault = async (alias: SendAsAlias) => {
    if (!account) return;
    await setDefaultAlias(account.id, alias.id);
    setAliases((prev) =>
      prev.map((a) => ({
        ...a,
        isDefault: a.id === alias.id,
      })),
    );
  };

  const handleReauthorize = async () => {
    if (!account) return;
    setReauthBusy(true);
    try {
      await reauthorizeAccount(account.id, account.email);
      setNeedsReauth(false);
      notify(
        "success",
        `${account.email} re-authorised`,
        "Refreshing aliases should work now.",
      );
    } catch (error) {
      reportError(`Re-authorisation failed for ${account.email}`, error);
    } finally {
      setReauthBusy(false);
    }
  };

  // Addresses connected to other accounts but not to this one — "connect it
  // here" is the same one-click add as a suggestion
  const connectable = [...elsewhere.entries()]
    .filter(([email]) => !aliases.some((a) => a.email.toLowerCase() === email))
    .map(([email, names]) => ({ email, names }));

  return (
    <Section title="Aliases">
      {!isMailAccount ? (
        <p className="text-xs text-text-tertiary mb-3">Send-as aliases are available for mail accounts.</p>
      ) : (
        <>
          <p className="text-xs text-text-tertiary mb-3">
            {isGmail
              ? "Addresses this account can send from, as registered on your Google account. sndmail can only read this list — Google reserves adding and removing send-as addresses for Gmail itself. Add or remove a domain alias in Gmail's settings (or your Workspace admin), then press Refresh."
              : "Addresses this account can send from. Your SMTP server decides which From addresses it accepts; replies automatically use the address the original email was sent to."}
          </p>
          {isGmail ? (
            <button
              type="button"
              onClick={() => void handleOpenGmailSettings()}
              className="mb-3 text-xs text-accent hover:text-accent-hover transition-colors inline-flex items-center gap-1"
            >
              <Mail size={13} />
              Open Gmail settings to manage send-as addresses
            </button>
          ) : (
            <>
              <div className="flex gap-2 mb-3">
                <input
                  type="email"
                  value={newAliasEmail}
                  onChange={(e) => setNewAliasEmail(e.target.value)}
                  placeholder="hello@reimedy.com"
                  aria-label="New alias address"
                  disabled={aliasBusy}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void handleAddAlias(newAliasEmail).then((added) => {
                        if (added) setNewAliasEmail("");
                      });
                    }
                  }}
                  className="flex-1 min-w-0 bg-bg-tertiary text-text-primary text-sm px-3 py-1.5 rounded-md border border-border-primary focus:border-accent outline-none disabled:opacity-50"
                />
                <Button
                  variant="secondary"
                  size="md"
                  disabled={aliasBusy || !newAliasEmail.trim()}
                  onClick={() =>
                    void handleAddAlias(newAliasEmail).then((added) => {
                      if (added) setNewAliasEmail("");
                    })
                  }
                >
                  Add alias
                </Button>
              </div>
              {aliasError && (
                <p role="alert" className="text-xs text-warning mb-3">{aliasError}</p>
              )}
            </>
          )}
          {needsReauth && account && (
            <div className="flex items-center justify-between gap-3 mb-3 px-3 py-2 rounded-md border border-warning/40 bg-warning/10">
              <p role="alert" className="text-xs text-warning">
                Gmail has not granted sndmail permission to read send-as addresses for this account. Re-authorize it to fix this.
              </p>
              <Button
                variant="secondary"
                size="sm"
                disabled={reauthBusy}
                onClick={() => void handleReauthorize()}
              >
                {reauthBusy && <Spinner size={12} label="Waiting for Google" />}
                Re-authorize
              </Button>
            </div>
          )}
          {suggestions.length > 0 && (
            <div className="mb-3 space-y-1.5">
              <p className="text-xs font-medium text-text-secondary">
                Suggested — addresses your mail was sent to
              </p>
              {suggestions.map((s) => (
                <div
                  key={s.email}
                  className="flex items-center justify-between gap-3 py-2 px-4 bg-bg-secondary rounded-lg"
                >
                  <span className="text-sm text-text-primary truncate">{s.email}</span>
                  <span className="text-xs text-text-tertiary truncate">
                    {isGmail
                      ? `${s.occurrences} message${s.occurrences === 1 ? "" : "s"} — set up in Gmail`
                      : `${s.occurrences} message${s.occurrences === 1 ? "" : "s"}`}
                  </span>
                  {!isGmail && (
                    <button
                      type="button"
                      onClick={() => void handleAddAlias(s.email)}
                      disabled={aliasBusy}
                      className="text-xs text-accent hover:text-accent-hover transition-colors shrink-0 disabled:opacity-50"
                    >
                      Add
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          {connectable.length > 0 && (
            <div className="mb-3 space-y-1.5">
              <p className="text-xs font-medium text-text-secondary">
                Connected to your other accounts
              </p>
              {connectable.map((s) => (
                <div
                  key={s.email}
                  className="flex items-center justify-between gap-3 py-2 px-4 bg-bg-secondary rounded-lg"
                >
                  <div className="min-w-0">
                    <div className="text-sm text-text-primary truncate">{s.email}</div>
                    <div className="text-xs text-text-tertiary truncate">
                      Also on {s.names.join(", ")}
                    </div>
                  </div>
                  {!isGmail && (
                    <button
                      type="button"
                      onClick={() => void handleAddAlias(s.email)}
                      disabled={aliasBusy}
                      className="text-xs text-accent hover:text-accent-hover transition-colors shrink-0 disabled:opacity-50"
                    >
                      Connect
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          {isGmail && (
            <>
              <button
                type="button"
                onClick={handleRefresh}
                disabled={refreshing}
                className="mb-3 flex items-center gap-1.5 text-xs text-accent hover:text-accent-hover disabled:opacity-50"
              >
                <RefreshCw size={13} className={refreshing ? "animate-spin" : ""} />
                {refreshing ? "Refreshing…" : "Refresh aliases"}
              </button>
              {loadError && (loadError.includes("403") || loadError.toLowerCase().includes("reauthorize")) && (
                <p role="alert" className="text-xs text-warning mb-3">
                  Gmail denied access to send-as settings. Re-authorize this Gmail account in Settings → Accounts, then try again. ({loadError})
                </p>
              )}
            </>
          )}
        </>
      )}
      {aliases.length === 0 ? (
        <p className="text-sm text-text-tertiary">
          {isGmail
            ? "No send-as addresses on your Google account yet. Add one in Gmail's settings (or your Workspace admin), then press Refresh."
            : isMailAccount
              ? "No aliases yet. Add one above, or add it from the suggestions when your mail was sent to another of your domains."
              : "No mail account selected."}
        </p>
      ) : (
        <div className="space-y-2">
          {aliases.map((alias) => (
            <div
              key={alias.id}
              className="flex items-center justify-between py-2.5 px-4 bg-bg-secondary rounded-lg"
            >
              <div className="flex items-center gap-3 min-w-0">
                <Mail size={15} className="text-text-tertiary shrink-0" />
                <div className="min-w-0">
                  <div className="text-sm font-medium text-text-primary truncate">
                    {alias.displayName ? `${alias.displayName} <${alias.email}>` : alias.email}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                    {alias.isPrimary && (
                      <span className="text-[0.625rem] bg-accent/15 text-accent px-1.5 py-0.5 rounded-full">
                        Primary
                      </span>
                    )}
                    {alias.isDefault && (
                      <span className="text-[0.625rem] bg-success/15 text-success px-1.5 py-0.5 rounded-full">
                        Default
                      </span>
                    )}
                    {alias.verificationStatus !== "accepted" && (
                      <span className="text-[0.625rem] bg-warning/15 text-warning px-1.5 py-0.5 rounded-full">
                        {alias.verificationStatus}
                      </span>
                    )}
                    {(elsewhere.get(alias.email.toLowerCase()) ?? []).length > 0 && (
                      <span className="text-[0.625rem] bg-bg-tertiary text-text-tertiary px-1.5 py-0.5 rounded-full">
                        Also on {elsewhere.get(alias.email.toLowerCase())!.join(", ")}
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-3 shrink-0 ml-3">
                {!alias.isDefault && (
                  <button
                    onClick={() => handleSetDefault(alias)}
                    className="text-xs text-accent hover:text-accent-hover transition-colors"
                  >
                    Set as default
                  </button>
                )}
                {!alias.isPrimary && !isGmail && (
                  <button
                    onClick={() => handleRemoveAlias(alias)}
                    disabled={aliasBusy}
                    className="text-xs text-danger hover:opacity-80 transition-colors disabled:opacity-50"
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

function isAuthRefusal(message: string): boolean {
  return (
    message.includes("403") ||
    message.toLowerCase().includes("not authorized") ||
    message.toLowerCase().includes("reauthorize")
  );
}
