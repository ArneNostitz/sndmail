//! IMAP IDLE — the mail server telling us when something changed.
//!
//! Polling asks "anything new?" sixty times an hour and is told "no" fifty
//! nine of them. IDLE inverts it: the client opens the connection outbound,
//! says IDLE, and the server holds it and speaks when there is something to
//! say. It works from a laptop behind NAT precisely because the connection
//! was dialled out — nothing needs a public address.
//!
//! What arrives is only a doorbell. The payload is ignored and a
//! `snd-idle-activity` event is emitted, which the app answers by running
//! the sync it would have run anyway. That keeps the Gmail API as the source
//! of truth for accounts that use it, and only replaces the waiting.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use async_imap::extensions::idle::IdleResponse;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use super::client::connect;
use super::types::ImapConfig;

/// RFC 2177 asks clients to renew IDLE at least every 29 minutes. Servers cut
/// idle connections at 30, so this re-issues comfortably inside that.
const IDLE_RENEW: Duration = Duration::from_secs(25 * 60);

/// How long to wait before reconnecting after the connection drops. Long
/// enough not to hammer a server that is refusing us, short enough that a
/// laptop waking from sleep is watching again quickly.
const RECONNECT_DELAY: Duration = Duration::from_secs(15);

/// A watcher per account, so starting twice is a no-op and stopping is exact.
#[derive(Default)]
pub struct IdleRegistry {
    watchers: Mutex<HashMap<String, CancellationToken>>,
}

impl IdleRegistry {
    pub fn new() -> Self {
        Self::default()
    }
}

/// What the frontend is told when the server speaks.
#[derive(Clone, serde::Serialize)]
struct IdleActivity {
    account_id: String,
}

/// What the frontend is told when a watcher cannot keep running.
#[derive(Clone, serde::Serialize)]
struct IdleFailure {
    account_id: String,
    error: String,
}

/// The watcher's connection state, so the app can say whether instant
/// delivery is actually live for an account rather than merely switched on.
#[derive(Clone, serde::Serialize)]
struct IdleStatus {
    account_id: String,
    /// "connected" while IDLE is held open, "disconnected" the moment it is not.
    state: &'static str,
}

fn emit_status(app: &AppHandle, account_id: &str, state: &'static str) {
    let _ = app.emit(
        "snd-idle-status",
        IdleStatus {
            account_id: account_id.to_string(),
            state,
        },
    );
}

/// Begin watching an account's INBOX. Starting an account that is already
/// watched replaces the old watcher, so a settings change cannot leave two.
pub async fn start(
    app: AppHandle,
    registry: Arc<IdleRegistry>,
    account_id: String,
    config: ImapConfig,
) -> Result<(), String> {
    stop(registry.clone(), &account_id).await;

    let token = CancellationToken::new();
    registry
        .watchers
        .lock()
        .await
        .insert(account_id.clone(), token.clone());

    tokio::spawn(async move {
        watch_loop(app, account_id, config, token).await;
    });
    Ok(())
}

/// Stop watching an account. Safe to call for an account that is not watched.
pub async fn stop(registry: Arc<IdleRegistry>, account_id: &str) {
    if let Some(token) = registry.watchers.lock().await.remove(account_id) {
        token.cancel();
    }
}

/// Stop every watcher — used when the setting is switched off or on shutdown.
pub async fn stop_all(registry: Arc<IdleRegistry>) {
    let mut watchers = registry.watchers.lock().await;
    for (_, token) in watchers.drain() {
        token.cancel();
    }
}

/// Errors that retrying cannot fix. A wrong security mode, a refused login,
/// a host that does not resolve — the fifteen-second loop would repeat these
/// forever and make a permanent problem look like a flaky connection. They
/// stop the watcher; "Reconnect" in settings, or a re-authorisation, starts
/// it again.
fn is_permanent(err: &str) -> bool {
    let e = err.to_ascii_lowercase();
    // A DNS lookup failing is a Wi-Fi flap, not a misconfiguration — it
    // stopped a watcher for good on one blip, so it is not in this list
    e.contains("unknown security mode")
        || e.contains("authenticationfailed")
        || e.contains("invalid credentials")
        || e.contains("[auth]")
}

/// Reconnect until cancelled. A dropped connection is normal — servers close
/// idle sockets, laptops sleep, networks change — so this treats it as
/// something to recover from rather than an error to report. Errors that
/// will not change on their own end the loop instead.
async fn watch_loop(
    app: AppHandle,
    account_id: String,
    config: ImapConfig,
    token: CancellationToken,
) {
    loop {
        if token.is_cancelled() {
            return;
        }

        let outcome = idle_session(&app, &account_id, &config, &token).await;
        emit_status(&app, &account_id, "disconnected");
        match outcome {
            Ok(()) => {
                // Cancelled from outside; nothing to recover from
                return;
            }
            Err(err) => {
                if token.is_cancelled() {
                    return;
                }
                let permanent = is_permanent(&err);
                if permanent {
                    log::warn!("IDLE for {account_id} stopped: {err}");
                } else {
                    log::warn!("IDLE for {account_id} dropped: {err}");
                }
                let _ = app.emit(
                    "snd-idle-failed",
                    IdleFailure {
                        account_id: account_id.clone(),
                        error: err,
                    },
                );
                if permanent {
                    return;
                }
            }
        }

        tokio::select! {
            _ = token.cancelled() => return,
            _ = tokio::time::sleep(RECONNECT_DELAY) => {}
        }
    }
}

/// One connection's worth of idling. Returns `Ok` only when cancelled.
async fn idle_session(
    app: &AppHandle,
    account_id: &str,
    config: &ImapConfig,
    token: &CancellationToken,
) -> Result<(), String> {
    let mut session = connect(config).await?;
    session
        .select("INBOX")
        .await
        .map_err(|e| format!("Could not select INBOX for IDLE: {e}"))?;

    log::info!("IDLE watching {account_id}");
    emit_status(app, account_id, "connected");

    loop {
        let mut handle = session.idle();
        handle
            .init()
            .await
            .map_err(|e| format!("Could not start IDLE: {e}"))?;

        let outcome = {
            let (idle_future, stop) = handle.wait_with_timeout(IDLE_RENEW);
            tokio::select! {
                result = idle_future => Some(result),
                _ = token.cancelled() => {
                    // Dropping the stop source ends the wait cleanly
                    drop(stop);
                    None
                }
            }
        };

        let Some(result) = outcome else {
            let _ = handle.done().await;
            return Ok(());
        };

        session = handle
            .done()
            .await
            .map_err(|e| format!("Could not end IDLE: {e}"))?;

        match result {
            // The server spoke: something changed. What changed is not worth
            // parsing — the sync that follows finds out authoritatively.
            Ok(IdleResponse::NewData(_)) => {
                let _ = app.emit(
                    "snd-idle-activity",
                    IdleActivity {
                        account_id: account_id.to_string(),
                    },
                );
            }
            // Renewal window elapsed with nothing to report: idle again.
            Ok(IdleResponse::Timeout) => {}
            Ok(IdleResponse::ManualInterrupt) => return Ok(()),
            Err(e) => return Err(format!("IDLE ended: {e}")),
        }
    }
}
