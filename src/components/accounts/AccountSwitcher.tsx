import { useMemo, useState, useRef, useCallback, useEffect } from "react";
import { useIdleStatusStore, describeIdleState, type IdleState } from "@/stores/idleStatusStore";
import { useAccountStore, mailAccounts, type Account } from "@/stores/accountStore";
import { ChevronDown, Check, Plus, UserPlus, Layers, RefreshCw } from "lucide-react";
import { useClickOutside } from "@/hooks/useClickOutside";
import { useUIStore } from "@/stores/uiStore";
import { accountColor } from "@/constants/accountColors";
import { getAliasesForAccount, mapDbAlias, type SendAsAlias } from "@/services/db/sendAsAliases";
import { refreshMail } from "@/services/refreshMail";
import { AtSign } from "lucide-react";

interface AccountSwitcherProps {
  collapsed: boolean;
  onAddAccount: () => void;
}

export function AccountSwitcher({
  collapsed,
  onAddAccount,
}: AccountSwitcherProps) {
  const {
    accounts,
    activeAccountId,
    unifiedInbox,
    activeAliasEmail,
    setActiveAccount,
    setUnifiedInbox,
    setActiveIdentity,
  } = useAccountStore();
  // Send-as addresses per account, so the dropdown can offer them as identities
  const [aliasesByAccount, setAliasesByAccount] = useState<Record<string, SendAsAlias[]>>({});
  const [open, setOpen] = useState(false);
  // Custom hover states — the system tooltip is too slow, ours pops immediately
  const [tooltipVisible, setTooltipVisible] = useState(false);
  const [avatarHover, setAvatarHover] = useState(false);
  const dropdownRef = useRef<HTMLDivElement | null>(null);
  const syncState = useUIStore((s) => s.syncState);
  const syncMessage = useUIStore((s) => s.syncMessage);

  useClickOutside(dropdownRef, () => setOpen(false));

  const activeAccount = accounts.find((a) => a.id === activeAccountId);

  // Instant delivery, summarised for what the tooltip is about: one account,
  // or every listed one when the inbox is unified
  const idleStatuses = useIdleStatusStore((s) => s.statuses);
  const idleSummary = useMemo(() => {
    const ids = unifiedInbox
      ? mailAccounts(accounts).map((a) => a.id)
      : activeAccount ? [activeAccount.id] : [];
    const states = ids.map((id) => idleStatuses[id] ?? "off");
    if (states.length === 0) return { state: "off" as IdleState, label: describeIdleState("off") };
    const connected = states.filter((st) => st === "connected").length;
    if (states.length === 1) {
      return { state: states[0]!, label: describeIdleState(states[0]) };
    }
    if (connected === states.length) return { state: "connected" as IdleState, label: "Instant delivery on" };
    if (states.some((st) => st === "connecting")) return { state: "connecting" as IdleState, label: `Connecting… ${connected}/${states.length} live` };
    if (connected > 0) return { state: "failed" as IdleState, label: `Instant delivery on ${connected}/${states.length}` };
    return { state: states.includes("failed") ? "failed" as IdleState : "off" as IdleState, label: describeIdleState(states.includes("failed") ? "failed" : "off") };
  }, [idleStatuses, unifiedInbox, accounts, activeAccount]);
  // Unified only makes sense with more than one mailbox to unify
  const canUnify = mailAccounts(accounts).length > 1;

  // Only load once the dropdown is opened — this is not startup work
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        mailAccounts(accounts).map(async (account) => {
          try {
            const rows = await getAliasesForAccount(account.id);
            return [account.id, rows.map(mapDbAlias)] as const;
          } catch {
            return [account.id, [] as SendAsAlias[]] as const;
          }
        }),
      );
      if (!cancelled) setAliasesByAccount(Object.fromEntries(entries));
    })();
    return () => { cancelled = true; };
  }, [open, accounts]);

  const handleUnified = useCallback(() => {
    setUnifiedInbox(true);
    setOpen(false);
  }, [setUnifiedInbox]);

  const handleSwitch = useCallback(
    (id: string) => {
      setActiveAccount(id);
      setOpen(false);
    },
    [setActiveAccount],
  );

  const handleIdentity = useCallback(
    (accountId: string, aliasEmail: string) => {
      setActiveIdentity(accountId, aliasEmail);
      setOpen(false);
    },
    [setActiveIdentity],
  );

  const handleAdd = useCallback(() => {
    onAddAccount();
    setOpen(false);
  }, [onAddAccount]);

  const handleRefresh = useCallback((e: React.SyntheticEvent) => {
    // The avatar sits inside the dropdown trigger — refresh must not open it
    e.stopPropagation();
    refreshMail();
  }, []);

  // No accounts — prompt to add
  if (accounts.length === 0) {
    return (
      <div className="p-3">
        <button
          onClick={onAddAccount}
          className={`flex items-center w-full rounded-lg p-2 text-sm text-sidebar-text/70 hover:bg-sidebar-hover hover:text-sidebar-text transition-colors ${
            collapsed ? "justify-center" : "gap-3"
          }`}
        >
          <div className="w-8 h-8 rounded-full bg-accent/10 flex items-center justify-center shrink-0">
            <UserPlus size={16} className="text-accent" />
          </div>
          {!collapsed && <span className="font-medium">Add Account</span>}
        </button>
      </div>
    );
  }

  return (
    <div className="relative p-2" ref={dropdownRef}>
      {/* Trigger button */}
      <button
        onClick={() => setOpen((v) => !v)}
        onMouseEnter={() => setTooltipVisible(true)}
        onMouseLeave={() => setTooltipVisible(false)}
        className={`flex items-center w-full rounded-lg p-1.5 hover:bg-sidebar-hover transition-colors ${
          collapsed ? "justify-center" : "gap-2.5"
        } ${open ? "bg-sidebar-hover" : ""}`}
      >
        {/* Hovering the avatar turns it into a refresh button */}
        <span
          role="button"
          tabIndex={0}
          aria-label="Refresh mail (F5)"
          onClick={handleRefresh}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              handleRefresh(e);
            }
          }}
          onMouseEnter={() => setAvatarHover(true)}
          onMouseLeave={() => setAvatarHover(false)}
          className="shrink-0 cursor-pointer"
        >
          {avatarHover ? (
            <span className="w-8 h-8 rounded-full bg-accent/15 text-accent flex items-center justify-center shrink-0">
              <RefreshCw
                size={15}
                className={syncState === "syncing" ? "animate-spin" : ""}
              />
            </span>
          ) : (
            <SyncRing state={syncState}>
              {unifiedInbox ? <UnifiedAvatar /> : <ActiveAvatar account={activeAccount} />}
            </SyncRing>
          )}
        </span>
        {!collapsed && (unifiedInbox || activeAccount) && (
          <>
            <div className="flex-1 min-w-0 text-left">
              <div className="text-sm font-medium text-sidebar-text truncate leading-tight">
                {unifiedInbox
                  ? "All Inboxes"
                  : activeAccount!.displayName || activeAccount!.email.split("@")[0]}
              </div>
              <div className="text-xs text-sidebar-text/50 truncate leading-tight">
                {unifiedInbox
                  ? `${mailAccounts(accounts).length} accounts`
                  : (activeAliasEmail ?? activeAccount!.email)}
              </div>
            </div>
            <ChevronDown
              size={14}
              className={`shrink-0 text-sidebar-text/40 transition-transform duration-200 ${
                open ? "rotate-180" : ""
              }`}
            />
          </>
        )}
      </button>

      {/* Immediate tooltip — no system-tooltip delay */}
      {tooltipVisible && !open && (
        <div
          role="tooltip"
          className={`absolute z-50 px-3 py-2 rounded-lg border border-border-primary bg-bg-primary shadow-lg glass-panel pointer-events-none w-56 ${
            collapsed ? "left-full ml-1 top-2" : "left-2 top-full -mt-1"
          }`}
        >
          <div className="text-xs font-medium text-text-primary truncate">
            {unifiedInbox
              ? "All Inboxes"
              : activeAccount?.displayName || activeAccount?.email || "No account"}
          </div>
          <div className="text-[0.6875rem] text-text-secondary truncate">
            {unifiedInbox
              ? `${mailAccounts(accounts).length} accounts`
              : (activeAliasEmail ?? activeAccount?.email ?? "")}
          </div>
          {syncState !== "idle" && (
            <div
              className={`text-[0.6875rem] mt-1 truncate ${
                syncState === "error" ? "text-danger" : "text-accent"
              }`}
            >
              {syncMessage ?? (syncState === "error" ? "Sync failed" : "Syncing...")}
            </div>
          )}
          {/* Whether the server is pushing to us, or we are still asking it */}
          <div
            className={`text-[0.6875rem] mt-1 flex items-center gap-1.5 ${
              idleSummary.state === "connected"
                ? "text-success"
                : idleSummary.state === "failed"
                  ? "text-warning"
                  : "text-text-tertiary"
            }`}
          >
            <span
              aria-hidden="true"
              className={`inline-block w-1.5 h-1.5 rounded-full ${
                idleSummary.state === "connected"
                  ? "bg-success"
                  : idleSummary.state === "connecting"
                    ? "bg-accent animate-pulse"
                    : idleSummary.state === "failed"
                      ? "bg-warning"
                      : "bg-text-tertiary"
              }`}
            />
            {idleSummary.label}
          </div>
          <div className="text-[0.625rem] text-text-tertiary mt-1">
            Click avatar to refresh · F5
          </div>
        </div>
      )}

      {/* Dropdown */}
      {open && (
        <div
          className={`absolute z-50 mt-1 py-1 rounded-lg border border-border-primary bg-bg-primary shadow-lg glass-panel ${
            collapsed ? "left-full ml-1 top-0 w-64" : "left-2 right-2"
          }`}
        >
          {canUnify && (
            <>
              <button
                onClick={handleUnified}
                className={`flex items-center gap-2.5 w-full px-3 py-2 text-left transition-colors ${
                  unifiedInbox
                    ? "bg-accent/8 text-accent"
                    : "text-text-primary hover:bg-bg-hover"
                }`}
              >
                <div
                  className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${
                    unifiedInbox ? "bg-accent text-white" : "bg-bg-tertiary text-text-secondary"
                  }`}
                >
                  <Layers size={14} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate leading-tight">
                    All Inboxes
                  </div>
                  <div className="text-xs text-text-secondary truncate leading-tight">
                    Every account in one list
                  </div>
                </div>
                {unifiedInbox && <Check size={14} className="shrink-0 text-accent" />}
              </button>
              <div className="border-t border-border-primary my-1" />
            </>
          )}
          {mailAccounts(accounts).length > 1 && (
            <div className="px-3 py-1.5 text-[0.625rem] font-medium text-text-tertiary uppercase tracking-wider">
              Accounts
            </div>
          )}
          {accounts.map((account, accountIndex) => {
            // A CalDAV account has no mailbox to switch to — it is picked on
            // the Calendar page instead
            if (account.provider === "caldav") return null;
            const isActive = !unifiedInbox && account.id === activeAccountId;
            const color = accountColor(account.color, accountIndex);
            return (
              <button
                key={account.id}
                onClick={() => handleSwitch(account.id)}
                className={`flex items-center gap-2.5 w-full px-3 py-2 text-left transition-colors ${
                  isActive
                    ? "bg-accent/8 text-accent"
                    : "text-text-primary hover:bg-bg-hover"
                }`}
              >
                <AccountAvatarSmall account={account} isActive={isActive} />
                <span
                  className="w-1.5 h-6 rounded-full shrink-0 -ml-1"
                  style={{ backgroundColor: color.hex }}
                  aria-hidden="true"
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate leading-tight">
                    {account.displayName || account.email.split("@")[0]}
                  </div>
                  <div className="text-xs text-text-secondary truncate leading-tight">
                    {account.email}
                  </div>
                </div>
                {isActive && !activeAliasEmail && (
                  <Check size={14} className="shrink-0 text-accent" />
                )}
              </button>
            );
          })}

          {/* Send-as addresses, offered as identities to send from. These come
              from the account's Gmail settings — sndmail cannot invent them. */}
          {mailAccounts(accounts).flatMap((account) => {
            const extras = (aliasesByAccount[account.id] ?? []).filter(
              (alias) => alias.email !== account.email,
            );
            return extras.map((alias) => {
              const isActiveIdentity =
                !unifiedInbox &&
                account.id === activeAccountId &&
                activeAliasEmail === alias.email;
              return (
                <button
                  key={`${account.id}:${alias.id}`}
                  onClick={() => handleIdentity(account.id, alias.email)}
                  title={`Send as ${alias.email} using ${account.email}`}
                  className={`flex items-center gap-2.5 w-full pl-8 pr-3 py-1.5 text-left transition-colors ${
                    isActiveIdentity
                      ? "bg-accent/8 text-accent"
                      : "text-text-primary hover:bg-bg-hover"
                  }`}
                >
                  <AtSign size={12} className="shrink-0 text-text-tertiary" />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs truncate leading-tight">{alias.email}</div>
                  </div>
                  {isActiveIdentity && (
                    <Check size={13} className="shrink-0 text-accent" />
                  )}
                </button>
              );
            });
          })}
          <div className="border-t border-border-primary my-1" />
          <button
            onClick={handleAdd}
            className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors"
          >
            <div className="w-7 h-7 rounded-full bg-bg-tertiary flex items-center justify-center shrink-0">
              <Plus size={14} />
            </div>
            <span>Add account</span>
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Wraps the account avatar in a ring that spins while mail is syncing and
 * turns red when a sync fails — replaces the status bar that used to sit
 * across the bottom of the window.
 */
function SyncRing({
  state,
  children,
}: {
  state: "idle" | "syncing" | "error";
  children: React.ReactNode;
}) {
  if (state === "idle") return <>{children}</>;

  return (
    <div className="relative shrink-0">
      {children}
      <span
        aria-hidden="true"
        className={`absolute -inset-1 rounded-full border-2 border-transparent ${
          state === "error" ? "border-danger/70" : "border-t-accent animate-spin"
        }`}
      />
      <span className="sr-only">{state === "error" ? "Sync failed" : "Syncing"}</span>
    </div>
  );
}

/** Trigger avatar for the unified view */
function UnifiedAvatar() {
  return (
    <div className="w-8 h-8 rounded-full bg-accent/15 text-accent flex items-center justify-center shrink-0">
      <Layers size={16} />
    </div>
  );
}

/** The main avatar shown in the trigger — slightly larger */
function ActiveAvatar({ account }: { account: Account | undefined }) {
  const [imgError, setImgError] = useState(false);

  if (!account) return null;

  const initial = (
    account.displayName?.[0] ?? account.email[0] ?? "?"
  ).toUpperCase();
  const showImg = account.avatarUrl && !imgError;

  return (
    <div className="w-8 h-8 rounded-full bg-accent/15 text-accent flex items-center justify-center shrink-0 text-sm font-semibold overflow-hidden">
      {showImg ? (
        <img
          key={account.avatarUrl}
          src={account.avatarUrl!}
          alt={account.email}
          className="w-full h-full object-cover"
          onError={() => setImgError(true)}
        />
      ) : (
        initial
      )}
    </div>
  );
}

/** Smaller avatar used inside the dropdown list */
function AccountAvatarSmall({
  account,
  isActive,
}: {
  account: Account;
  isActive: boolean;
}) {
  const [imgError, setImgError] = useState(false);

  const initial = (
    account.displayName?.[0] ?? account.email[0] ?? "?"
  ).toUpperCase();
  const showImg = account.avatarUrl && !imgError;

  return (
    <div
      className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 text-xs font-semibold overflow-hidden ${
        isActive
          ? "bg-accent text-white"
          : "bg-accent/12 text-accent"
      }`}
    >
      {showImg ? (
        <img
          key={account.avatarUrl}
          src={account.avatarUrl!}
          alt=""
          className="w-full h-full object-cover"
          onError={() => setImgError(true)}
        />
      ) : (
        initial
      )}
    </div>
  );
}
