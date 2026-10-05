import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getAllAccounts, type DbAccount } from "@/services/db/accounts";
import { getSetting } from "@/services/db/settings";
import { buildImapConfig } from "./imapConfigBuilder";
import { useIdleStatusStore, explainIdleFailure } from "@/stores/idleStatusStore";
import { reportError } from "@/stores/toastStore";

/**
 * Let the mail server say when something changed, instead of asking it.
 *
 * The Rust side holds an IMAP IDLE connection per account and emits
 * `snd-idle-activity` when the server speaks. That event is only a doorbell:
 * the sync that answers it is the normal delta path, so a Gmail account keeps
 * using the Gmail API for the actual data without polling every mailbox.
 */

/**
 * Gmail's IMAP endpoint, for accounts that sync over the API.
 *
 * `security` is the value the Rust side matches on — "tls", not the "ssl"
 * the account form stores and `mapSecurity()` translates. Hand-building this
 * config bypassed that translation, and every watcher was refused with
 * "Unknown security mode: ssl" from the first attempt.
 */
const GMAIL_IMAP = { host: "imap.gmail.com", port: 993, security: "tls" as const };

/** Ignore a second doorbell for the same account within this window. */
const DEBOUNCE_MS = 3000;

/**
 * How long to wait before each automatic retry after a watcher stops.
 *
 * The common failure is not a broken account at all: an OAuth access token
 * lives about an hour, the Rust watcher holds the config it was handed, and
 * the first reconnect after the token expires is refused with
 * `AUTHENTICATIONFAILED`. Rust reads that as permanent and ends the loop, so
 * the account would expose the failure and remain available for manual refresh.
 * Retrying goes back through
 * `startIdleWatcher`, which mints a fresh token, so the first retry normally
 * succeeds. Only when all of these are used up is it worth telling the user.
 */
const RETRY_DELAYS_MS = [5_000, 30_000, 2 * 60_000, 10 * 60_000];

let unlistenActivity: UnlistenFn | null = null;
let unlistenFailure: UnlistenFn | null = null;
let unlistenStatus: UnlistenFn | null = null;
let lastFired = new Map<string, number>();
const failedAccounts = new Set<string>();
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const retryAttempts = new Map<string, number>();

/** Stop retrying an account — it connected, or the watchers are going away. */
function clearRetries(accountId: string): void {
  const timer = retryTimers.get(accountId);
  if (timer) clearTimeout(timer);
  retryTimers.delete(accountId);
  retryAttempts.delete(accountId);
}

/**
 * A watcher stopped. Try again with a freshly minted token before saying so
 * out loud; report only once the retries are spent.
 */
function scheduleRetry(account: DbAccount, error: string): void {
  const attempt = retryAttempts.get(account.id) ?? 0;
  const delay = RETRY_DELAYS_MS[attempt];

  if (delay === undefined) {
    useIdleStatusStore.getState().setStatus(account.id, "failed", error);
    reportError(`Instant delivery unavailable for ${account.email}`, explainIdleFailure(error), {
      label: "Reconnect",
      run: () => reconnectAccount(account.id),
    });
    return;
  }

  retryAttempts.set(account.id, attempt + 1);
  // Still "connecting": a retry is pending, and the account is not stuck
  useIdleStatusStore.getState().setStatus(account.id, "connecting");
  const existing = retryTimers.get(account.id);
  if (existing) clearTimeout(existing);
  retryTimers.set(
    account.id,
    setTimeout(() => {
      retryTimers.delete(account.id);
      void startIdleWatcher(account);
    }, delay),
  );
}

/** Accounts that could not idle, so the UI can explain the fallback. */
export function accountsWithoutIdle(): Set<string> {
  return new Set(failedAccounts);
}

/**
 * Whether an account can idle at all.
 *
 * A Gmail account authorised before the full-mailbox scope was requested has
 * a token IMAP will refuse, and there is no way to tell from here — the
 * connection failing is what says so, and the watcher stops for that account.
 */
function idleConfigFor(account: DbAccount, accessToken?: string) {
  if (account.provider === "imap") {
    if (!account.imap_host) return null;
    return buildImapConfig(account, accessToken);
  }
  if (account.provider === "gmail_api") {
    if (!accessToken) return null;
    return {
      ...GMAIL_IMAP,
      username: account.email,
      password: accessToken,
      auth_method: "oauth2",
      accept_invalid_certs: false,
    };
  }
  return null;
}

/**
 * Start watching every account that can be watched.
 *
 * Safe to call again — the Rust side replaces an account's watcher rather
 * than adding a second, so a settings change or a new account just re-runs
 * this.
 */
export async function startIdleWatchers(): Promise<void> {
  const enabled = (await getSetting("imap_idle")) !== "false";
  if (!enabled) {
    await stopIdleWatchers();
    return;
  }

  await attachListeners();

  const accounts = await getAllAccounts();
  for (const account of accounts) {
    if (account.is_active === 0) continue;
    await startIdleWatcher(account);
  }
}

/** Start (or restart) the watcher for one account. */
async function startIdleWatcher(account: DbAccount): Promise<void> {
  const { setStatus } = useIdleStatusStore.getState();
  try {
    let accessToken: string | undefined;
    if (account.auth_method !== "password") {
      const { ensureFreshToken } = await import("@/services/oauth/oauthTokenManager");
      accessToken = await ensureFreshToken(account);
    }
    const config = idleConfigFor(account, accessToken);
    if (!config) {
      setStatus(account.id, "off");
      return;
    }

    // "connecting" until the watcher reports in — the Rust side owns the
    // truth from here, and it may take a few seconds
    setStatus(account.id, "connecting");
    await invoke("imap_start_idle", { accountId: account.id, config });
    failedAccounts.delete(account.id);
  } catch (err) {
    // Not fatal: retries mint a fresh token; manual refresh remains available.
    failedAccounts.add(account.id);
    console.warn(`IDLE unavailable for ${account.email}:`, err);
    scheduleRetry(account, String(err));
  }
}

/**
 * Reconnect one account — not all of them. Pressing Reconnect on a row
 * used to restart every watcher, which is confusing to watch and pointless
 * for the four that were fine.
 */
export async function reconnectAccount(accountId: string): Promise<void> {
  const enabled = (await getSetting("imap_idle")) !== "false";
  if (!enabled) return;
  await attachListeners();
  const account = (await getAllAccounts()).find((a) => a.id === accountId);
  if (!account || account.is_active === 0) return;
  // Asking by hand starts the retry budget over
  clearRetries(accountId);
  await startIdleWatcher(account);
}

/** Stop every watcher and detach the listeners. */
export async function stopIdleWatchers(): Promise<void> {
  try {
    await invoke("imap_stop_all_idle");
  } catch (err) {
    console.error("Failed to stop IDLE watchers:", err);
  }
  unlistenActivity?.();
  unlistenActivity = null;
  unlistenFailure?.();
  unlistenFailure = null;
  unlistenStatus?.();
  unlistenStatus = null;
  for (const id of [...retryTimers.keys()]) clearRetries(id);
  lastFired = new Map();
  useIdleStatusStore.getState().clearAll();
}

async function attachListeners(): Promise<void> {
  if (unlistenActivity) return;

  unlistenActivity = await listen<{ account_id: string }>(
    "snd-idle-activity",
    (event) => {
      const accountId = event.payload.account_id;
      // A single arriving message can produce several untagged responses;
      // one sync answers all of them
      const now = Date.now();
      if (now - (lastFired.get(accountId) ?? 0) < DEBOUNCE_MS) return;
      lastFired.set(accountId, now);

      window.dispatchEvent(
        new CustomEvent("snd-idle-sync", { detail: { accountId } }),
      );
    },
  );

  unlistenFailure = await listen<{ account_id: string; error: string }>(
    "snd-idle-failed",
    (event) => {
      const { account_id, error } = event.payload;
      failedAccounts.add(account_id);
      console.warn(`IDLE dropped for ${account_id}: ${error}`);
      // Rust ends its loop on a refusal, so recovery has to start here — and
      // the usual refusal is just an expired access token, which is fixed by
      // connecting again with a new one rather than by telling the user
      void (async () => {
        const account = (await getAllAccounts()).find((a) => a.id === account_id);
        if (!account || account.is_active === 0) return;
        scheduleRetry(account, error);
      })();
    },
  );

  // The watcher's own word on whether the connection is up. A drop reads as
  // "connecting" rather than "failed": the Rust loop is already reconnecting,
  // and only a refusal (above) means the account is stuck on the timer.
  unlistenStatus = await listen<{ account_id: string; state: "connected" | "disconnected" }>(
    "snd-idle-status",
    (event) => {
      const { account_id, state } = event.payload;
      const store = useIdleStatusStore.getState();
      if (state === "connected") {
        failedAccounts.delete(account_id);
        clearRetries(account_id);
        store.setStatus(account_id, "connected");
      } else if (store.statuses[account_id] !== "failed") {
        store.setStatus(account_id, "connecting");
      }
    },
  );
}
