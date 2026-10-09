//! Mail work that survives closing the WebView. The worker uses the same
//! account, message, thread and label tables as the foreground application.
//! It never runs schema migrations: an old or absent database is left alone
//! until the app has opened it.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_imap::extensions::idle::IdleResponse;
use base64::Engine;
use chrono::{Datelike, Duration as ChronoDuration, Utc};
use futures::StreamExt;
use ring::aead::{self, Aad, LessSafeKey, Nonce, UnboundKey};
use serde_json::Value;
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{Connection, Row, SqliteConnection};

use super::WorkerContext;
mod otp;
use crate::imap::{
    client as imap,
    types::{ImapConfig, ImapFolder, ImapMessage},
};

const GMAIL: &str = "https://www.googleapis.com/gmail/v1/users/me";
const MAX_INITIAL_THREADS: usize = 10_000;
const BATCH_SIZE: usize = 50;
const RETRY_INTERVAL: Duration = Duration::from_secs(5 * 60);
// A threads.get costs 40 Gmail quota units. Four GET starts per two seconds
// remain below the per-user minute limit even when every call is a thread.
const GMAIL_GET_SPACING: Duration = Duration::from_millis(500);
const GMAIL_MAX_RETRIES: u32 = 5;
const GMAIL_MAX_BACKOFF_MS: u64 = 32_000;
// The relay currently sends no heartbeat. Reopen a quiet stream periodically
// so a half-open connection cannot suppress push forever.
const RELAY_INACTIVITY: Duration = Duration::from_secs(10 * 60);

enum RelayExit {
    Shutdown,
    Reconfigure,
    Inactive,
}

#[derive(Clone)]
struct Account {
    id: String,
    email: String,
    provider: String,
    access_token: Option<String>,
    refresh_token: Option<String>,
    token_expires_at: i64,
    history_id: Option<String>,
    imap_host: Option<String>,
    imap_port: u16,
    imap_security: String,
    imap_username: Option<String>,
    imap_password: Option<String>,
    auth_method: String,
    oauth_provider: Option<String>,
    oauth_client_id: Option<String>,
    oauth_client_secret: Option<String>,
    accept_invalid_certs: bool,
}

pub(crate) async fn run(context: &WorkerContext) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|e| format!("create mail HTTP client: {e}"))?;
    let mut ticker = tokio::time::interval(RETRY_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let shutdown = context.shutdown();
    let mut idle_watchers: HashMap<String, tokio::task::JoinHandle<()>> = HashMap::new();
    let relay_context = context.clone();
    let relay_task = tokio::spawn(async move {
        watch_gmail_relay(relay_context).await;
    });
    loop {
        tokio::select! {
            _ = shutdown.cancelled() => { relay_task.abort(); return Ok(()); },
            _ = ticker.tick() => {},
            _ = context.wait_for_mail_change() => {},
        }
        if let Err(error) = sync_cycle(context, &client, &mut idle_watchers).await {
            log::warn!("background mail cycle failed: {}", error_category(&error));
            persist_file_status(context, "error", None, Some(error_category(&error)));
        }
    }
}

async fn watch_gmail_relay(context: WorkerContext) {
    let shutdown = context.shutdown();
    let stream_client = match reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .build()
    {
        Ok(client) => client,
        Err(_) => return,
    };
    loop {
        if shutdown.is_cancelled() {
            return;
        }
        match relay_session(&context, &stream_client).await {
            Ok(RelayExit::Shutdown) => return,
            Ok(RelayExit::Reconfigure) => {
                // Settings or account membership changed. Reload all registrations
                // and reconcile History without waiting for a timer.
                context.notify_mail_changed(String::new());
            }
            Ok(RelayExit::Inactive) => tokio::select! {
                _ = shutdown.cancelled() => return,
                _ = context.wait_for_relay_change() => {},
                _ = tokio::time::sleep(RETRY_INTERVAL) => {},
            },
            Err(error) => {
                log::warn!("Gmail relay reconnecting: {}", error_category(&error));
                // A missed stream event is repaired by the authoritative History API.
                context.notify_mail_changed(String::new());
                tokio::select! {
                    _ = shutdown.cancelled() => return,
                    _ = context.wait_for_relay_change() => {},
                    _ = tokio::time::sleep(Duration::from_secs(60)) => {},
                }
            }
        }
    }
}

async fn relay_session(context: &WorkerContext, http: &reqwest::Client) -> Result<RelayExit, String> {
    let Some(path) = database_path(context)? else {
        return Ok(RelayExit::Inactive);
    };
    let mut db = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(false),
    )
    .await
    .map_err(db_error)?;
    let Some(base) = setting(&mut db, "gmail_push_relay_url").await? else {
        return Ok(RelayExit::Inactive);
    };
    let Some(secret) = secure_setting(&mut db, "gmail_push_relay_secret").await? else {
        return Ok(RelayExit::Inactive);
    };
    let Some(topic) = setting(&mut db, "gmail_push_topic_name").await? else {
        return Ok(RelayExit::Inactive);
    };
    if base.trim().is_empty() || secret.is_empty() || topic.trim().is_empty() {
        return Ok(RelayExit::Inactive);
    }
    let base = base.trim().trim_end_matches('/');
    let parsed = reqwest::Url::parse(base).map_err(|_| "invalid relay URL".to_string())?;
    if parsed.scheme() != "https"
        && !(parsed.scheme() == "http"
            && parsed
                .host_str()
                .is_some_and(|h| h == "localhost" || h == "127.0.0.1"))
    {
        return Err("relay URL must use HTTPS".into());
    }
    let mut accounts: HashMap<String, Account> = load_accounts(&mut db)
        .await?
        .into_iter()
        .filter(|a| a.provider == "gmail_api")
        .map(|a| (a.email.to_ascii_lowercase(), a))
        .collect();
    for account in accounts.values_mut() {
        if let Err(error) = register_relay(&mut db, http, base, &secret, &topic, account).await {
            log::warn!(
                "Gmail relay registration failed: {}",
                error_category(&error)
            );
        }
    }
    let response = http
        .get(format!("{base}/events"))
        .header("Accept", "text/event-stream")
        .bearer_auth(&secret)
        .send()
        .await
        .map_err(|e| format!("connect Gmail relay: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("Gmail relay returned HTTP {}", response.status()));
    }
    let mut bytes = response.bytes_stream();
    let mut buffer = String::new();
    let shutdown = context.shutdown();
    loop {
        let next = tokio::select! {
            _ = shutdown.cancelled() => return Ok(RelayExit::Shutdown),
            _ = context.wait_for_relay_change() => return Ok(RelayExit::Reconfigure),
            _ = tokio::time::sleep(RELAY_INACTIVITY) => return Err("Gmail relay stream inactive".into()),
            value = bytes.next() => value,
        };
        let Some(chunk) = next else {
            return Err("Gmail relay stream closed".into());
        };
        let chunk = chunk.map_err(|e| format!("Gmail relay stream: {e}"))?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        if buffer.len() > 64 * 1024 {
            return Err("Gmail relay event exceeds size limit".into());
        }
        while let Some(end) = buffer.find("\n\n") {
            let event = buffer[..end].to_owned();
            buffer.drain(..end + 2);
            let Some(line) = event.lines().find_map(|line| line.strip_prefix("data: ")) else {
                continue;
            };
            let Ok(payload) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            let Some(email) = payload["email"].as_str() else {
                continue;
            };
            let Some(account) = accounts.get_mut(&email.to_ascii_lowercase()) else {
                continue;
            };
            match payload["type"].as_str() {
                Some("gmail-history") => context.notify_mail_changed(account.id.clone()),
                Some("renew-required") => {
                    if let Err(error) =
                        register_relay(&mut db, http, base, &secret, &topic, account).await
                    {
                        log::warn!(
                            "Gmail relay renewal failed: {}",
                            error_category(&error)
                        );
                    }
                }
                _ => {}
            }
        }
    }
}

async fn register_relay(
    db: &mut SqliteConnection,
    http: &reqwest::Client,
    base: &str,
    secret: &str,
    topic: &str,
    account: &mut Account,
) -> Result<(), String> {
    let access = gmail_token(db, http, account).await?;
    let response = http
        .post(format!("{base}/register"))
        .bearer_auth(secret)
        .json(
            &serde_json::json!({"email": account.email, "accessToken": access, "topicName": topic}),
        )
        .send()
        .await
        .map_err(|e| format!("Gmail relay registration: {e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Gmail relay registration HTTP {}",
            response.status()
        ));
    }
    Ok(())
}

async fn sync_cycle(
    context: &WorkerContext,
    client: &reqwest::Client,
    idle_watchers: &mut HashMap<String, tokio::task::JoinHandle<()>>,
) -> Result<(), String> {
    let Some(path) = database_path(context)? else {
        context.set_mail_ready(false);
        return Ok(());
    };
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(false)
        .busy_timeout(Duration::from_secs(5));
    let mut db = SqliteConnection::connect_with(&options)
        .await
        .map_err(db_error)?;
    let version: Option<i64> = sqlx::query_scalar("SELECT MAX(version) FROM _migrations")
        .fetch_optional(&mut db)
        .await
        .map_err(db_error)?
        .flatten();
    if version.unwrap_or_default() < 32 {
        // The frontend owns migration sequencing and may be doing it now.
        context.set_mail_ready(false);
        return Ok(());
    }
    sqlx::query("CREATE TABLE IF NOT EXISTS worker_change_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, changed_at INTEGER NOT NULL DEFAULT (unixepoch()))")
        .execute(&mut db).await.map_err(db_error)?;
    sqlx::query("CREATE TABLE IF NOT EXISTS worker_otp_notifications (account_id TEXT NOT NULL, message_id TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT (unixepoch()), PRIMARY KEY (account_id, message_id))")
        .execute(&mut db).await.map_err(db_error)?;
    sqlx::query("CREATE TABLE IF NOT EXISTS worker_mail_notifications (account_id TEXT NOT NULL, message_id TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT (unixepoch()), PRIMARY KEY (account_id, message_id))")
        .execute(&mut db).await.map_err(db_error)?;
    sqlx::query("CREATE TABLE IF NOT EXISTS worker_notification_status (id INTEGER PRIMARY KEY CHECK (id = 1), phase TEXT NOT NULL, permission TEXT NOT NULL, error TEXT, updated_at INTEGER NOT NULL DEFAULT (unixepoch()))")
        .execute(&mut db).await.map_err(db_error)?;
    sqlx::query("CREATE TABLE IF NOT EXISTS worker_mail_status (id INTEGER PRIMARY KEY CHECK (id = 1), phase TEXT NOT NULL, account_id TEXT, error TEXT, updated_at INTEGER NOT NULL DEFAULT (unixepoch()))")
        .execute(&mut db).await.map_err(db_error)?;
    sqlx::query("CREATE TABLE IF NOT EXISTS worker_mail_account_status (account_id TEXT PRIMARY KEY, phase TEXT NOT NULL, error TEXT, last_success_at INTEGER, updated_at INTEGER NOT NULL DEFAULT (unixepoch()))")
        .execute(&mut db).await.map_err(db_error)?;
    sqlx::query("CREATE TABLE IF NOT EXISTS worker_postprocess_queue (account_id TEXT NOT NULL, message_id TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()), PRIMARY KEY (account_id, message_id))")
        .execute(&mut db).await.map_err(db_error)?;
    sqlx::query("CREATE TABLE IF NOT EXISTS worker_resync_requests (account_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL DEFAULT (unixepoch()))")
        .execute(&mut db).await.map_err(db_error)?;
    sqlx::query("CREATE TABLE IF NOT EXISTS worker_sync_requests (account_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL DEFAULT (unixepoch()))")
        .execute(&mut db).await.map_err(db_error)?;
    let requested_syncs: HashSet<String> = sqlx::query_scalar("SELECT account_id FROM worker_sync_requests")
        .fetch_all(&mut db).await.map_err(db_error)?.into_iter().collect();
    let accounts = load_accounts(&mut db).await?;
    let known_account_ids: HashSet<String> = accounts.iter().map(|account| account.id.clone()).collect();
    context.set_mail_ready(true);
    set_status(context, &mut db, "ready", None, None).await?;
    let mut active_imap = HashSet::new();
    let mut failures = 0_usize;
    for mut account in accounts {
        let force_full: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM worker_resync_requests WHERE account_id = ?")
            .bind(&account.id).fetch_one(&mut db).await.map_err(db_error)?;
        let force_full = force_full > 0;
        let rotate_idle = account.provider == "imap" && account.auth_method == "oauth2"
            && account.token_expires_at <= Utc::now().timestamp() + 300;
        if account.provider == "imap" {
            active_imap.insert(account.id.clone());
        }
        let result = if account.provider == "imap" {
            set_status(context, &mut db, "syncing", Some(&account.id), None).await?;
            sqlx::query("INSERT INTO worker_mail_account_status (account_id, phase, error) VALUES (?, 'syncing', NULL) ON CONFLICT(account_id) DO UPDATE SET phase = 'syncing', error = NULL, updated_at = unixepoch()")
                .bind(&account.id).execute(&mut db).await.map_err(db_error)?;
            sync_imap(&mut db, client, &mut account, force_full).await
        } else if account.provider == "gmail_api" {
            set_status(context, &mut db, "syncing", Some(&account.id), None).await?;
            sqlx::query("INSERT INTO worker_mail_account_status (account_id, phase, error) VALUES (?, 'syncing', NULL) ON CONFLICT(account_id) DO UPDATE SET phase = 'syncing', error = NULL, updated_at = unixepoch()")
                .bind(&account.id).execute(&mut db).await.map_err(db_error)?;
            sync_gmail(&mut db, client, &mut account, force_full).await
        } else {
            continue;
        };
        match result {
            Ok(changed) => {
                set_status(context, &mut db, "ready", Some(&account.id), None).await?;
                sqlx::query("INSERT INTO worker_mail_account_status (account_id, phase, error, last_success_at) VALUES (?, 'ready', NULL, unixepoch()) ON CONFLICT(account_id) DO UPDATE SET phase = 'ready', error = NULL, last_success_at = unixepoch(), updated_at = unixepoch()")
                    .bind(&account.id).execute(&mut db).await.map_err(db_error)?;
                if force_full {
                    sqlx::query("DELETE FROM worker_resync_requests WHERE account_id = ?")
                        .bind(&account.id).execute(&mut db).await.map_err(db_error)?;
                }
                if requested_syncs.contains(&account.id) {
                    sqlx::query("DELETE FROM worker_sync_requests WHERE account_id = ?")
                        .bind(&account.id).execute(&mut db).await.map_err(db_error)?;
                }
                if changed {
                    sqlx::query("INSERT INTO worker_change_events (account_id) VALUES (?)")
                        .bind(&account.id)
                        .execute(&mut db)
                        .await
                        .map_err(db_error)?;
                    sqlx::query("DELETE FROM worker_change_events WHERE seq < (SELECT MAX(seq) - 2048 FROM worker_change_events)")
                        .execute(&mut db).await.map_err(db_error)?;
                    context.emit_mail_synced(account.id.clone());
                }
            }
            Err(error) => {
                failures += 1;
                log::warn!("background sync failed: {}", error_category(&error));
                set_status(context, &mut db, "error", Some(&account.id), Some(error_category(&error))).await?;
                sqlx::query("INSERT INTO worker_mail_account_status (account_id, phase, error) VALUES (?, 'error', ?) ON CONFLICT(account_id) DO UPDATE SET phase = 'error', error = excluded.error, updated_at = unixepoch()")
                    .bind(&account.id).bind(error_category(&error)).execute(&mut db).await.map_err(db_error)?;
                if requested_syncs.contains(&account.id) {
                    sqlx::query("DELETE FROM worker_sync_requests WHERE account_id = ?")
                        .bind(&account.id).execute(&mut db).await.map_err(db_error)?;
                }
            }
        }
        if account.provider == "imap" {
            if rotate_idle {
                if let Some(task) = idle_watchers.remove(&account.id) { task.abort(); }
            }
            if !idle_watchers.get(&account.id).is_some_and(|task| !task.is_finished()) {
                if let Ok(config) = imap_config(&account) {
                    let watcher_context = context.clone();
                    let id = account.id.clone();
                    idle_watchers.insert(id.clone(), tokio::spawn(async move {
                        watch_imap_idle(watcher_context, id, config).await;
                    }));
                }
            }
        }
    }
    for account_id in requested_syncs {
        if !known_account_ids.contains(&account_id) {
            sqlx::query("DELETE FROM worker_sync_requests WHERE account_id = ?")
                .bind(account_id).execute(&mut db).await.map_err(db_error)?;
        }
    }
    idle_watchers.retain(|id, task| {
        if active_imap.contains(id) {
            true
        } else {
            task.abort();
            false
        }
    });
    if let Err(error) = otp::retry_pending(&mut db).await {
        log::warn!("background notification retry unavailable: {}", error_category(&error));
    }
    if failures > 0 {
        let summary = format!("{failures} mail account(s) need attention");
        set_status(context, &mut db, "error", None, Some(&summary)).await?;
    } else {
        set_status(context, &mut db, "ready", None, None).await?;
    }
    Ok(())
}

fn database_path(context: &WorkerContext) -> Result<Option<std::path::PathBuf>, String> {
    let dir = context.data_dir()?;
    // The app owns migration of the old filename and WAL sidecars. Before its
    // first launch there is no initialized worker database to open.
    for filename in ["sndmail.db"] {
        let path = dir.join(filename);
        if path.is_file() {
            return Ok(Some(path));
        }
    }
    Ok(None)
}

async fn load_accounts(db: &mut SqliteConnection) -> Result<Vec<Account>, String> {
    let rows = sqlx::query("SELECT id, email, provider, access_token, refresh_token, token_expires_at, history_id, imap_host, imap_port, imap_security, imap_username, imap_password, auth_method, oauth_provider, oauth_client_id, oauth_client_secret, accept_invalid_certs FROM accounts WHERE is_active = 1 AND provider IN ('gmail_api', 'imap')")
        .fetch_all(db).await.map_err(db_error)?;
    let mut result = Vec::with_capacity(rows.len());
    for row in rows {
        result.push(Account {
            id: row.get("id"),
            email: row.get("email"),
            provider: row.get("provider"),
            access_token: row.get("access_token"),
            refresh_token: row.get("refresh_token"),
            token_expires_at: row.get::<Option<i64>, _>("token_expires_at").unwrap_or(0),
            history_id: row.get("history_id"),
            imap_host: row.get("imap_host"),
            imap_port: row
                .get::<Option<i64>, _>("imap_port")
                .unwrap_or(993)
                .try_into()
                .unwrap_or(993),
            imap_security: row
                .get::<Option<String>, _>("imap_security")
                .unwrap_or_else(|| "ssl".into()),
            imap_username: row.get("imap_username"),
            imap_password: row.get("imap_password"),
            auth_method: row
                .get::<Option<String>, _>("auth_method")
                .unwrap_or_default(),
            oauth_provider: row.get("oauth_provider"),
            oauth_client_id: row.get("oauth_client_id"),
            oauth_client_secret: row.get("oauth_client_secret"),
            accept_invalid_certs: row
                .get::<Option<i64>, _>("accept_invalid_certs")
                .unwrap_or(0)
                != 0,
        });
    }
    Ok(result)
}

fn encryption_key() -> Result<Vec<u8>, String> {
    // Fixtures must never read the user's real keychain, even if the test
    // process runs under the same login session.
    let fixture = std::env::var("SNDMAIL_WORKER_FIXTURE").as_deref() == Ok("1");
    let stored = if fixture { None } else {
        keyring::Entry::new("com.anydaysomething.sndmail", "db-encryption-key")
            .ok().and_then(|entry| entry.get_password().ok())
    };
    let encoded = if let Some(stored) = stored { stored } else {
        // Use only sndmail's canonical fallback file. Never create a new key here:
        // a wrong key would make existing credentials appear corrupt.
        let directory = if std::env::var("SNDMAIL_WORKER_FIXTURE").as_deref() == Ok("1") {
            std::env::var_os("SNDMAIL_WORKER_DATA_DIR").map(std::path::PathBuf::from)
        } else {
            let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
            #[cfg(target_os = "macos")]
            let base = home.map(|home| home.join("Library/Application Support"));
            #[cfg(target_os = "linux")]
            let base = std::env::var_os("XDG_DATA_HOME").map(std::path::PathBuf::from)
                .or_else(|| home.map(|home| home.join(".local/share")));
            #[cfg(target_os = "windows")]
            let base = std::env::var_os("APPDATA").map(std::path::PathBuf::from)
                .or_else(|| home.map(|home| home.join("AppData/Roaming")));
            base.map(|base| base.join("com.anydaysomething.sndmail"))
        }.ok_or("encryption key unavailable")?;
        std::fs::read_to_string(directory.join("sndmail.key"))
            .map_err(|_| "encryption key unavailable")?
    };
    base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .map_err(|_| "invalid encryption key".to_string())
}

fn decrypt(value: &str) -> Result<String, String> {
    let Some((iv, ciphertext)) = value.split_once(':') else {
        return Ok(value.to_owned());
    };
    let decoder = base64::engine::general_purpose::STANDARD;
    let Ok(iv) = decoder.decode(iv) else {
        return Ok(value.to_owned());
    };
    if iv.len() != 12 {
        return Ok(value.to_owned());
    }
    let mut ciphertext = decoder
        .decode(ciphertext)
        .map_err(|_| "invalid encrypted credential".to_string())?;
    let key = encryption_key()?;
    let unbound = UnboundKey::new(&aead::AES_256_GCM, &key)
        .map_err(|_| "invalid encryption key".to_string())?;
    let nonce = Nonce::try_assume_unique_for_key(&iv)
        .map_err(|_| "invalid encrypted credential".to_string())?;
    let plaintext = LessSafeKey::new(unbound)
        .open_in_place(nonce, Aad::empty(), &mut ciphertext)
        .map_err(|_| "cannot decrypt account credential".to_string())?;
    String::from_utf8(plaintext.to_vec()).map_err(|_| "invalid credential encoding".to_string())
}

fn encrypt(value: &str) -> Result<String, String> {
    let key = encryption_key()?;
    let unbound = UnboundKey::new(&aead::AES_256_GCM, &key)
        .map_err(|_| "invalid encryption key".to_string())?;
    let mut iv = [0u8; 12];
    getrandom::getrandom(&mut iv).map_err(|_| "cannot generate token nonce".to_string())?;
    let nonce = Nonce::assume_unique_for_key(iv);
    let mut bytes = value.as_bytes().to_vec();
    LessSafeKey::new(unbound)
        .seal_in_place_append_tag(nonce, Aad::empty(), &mut bytes)
        .map_err(|_| "cannot encrypt refreshed token".to_string())?;
    let encoder = base64::engine::general_purpose::STANDARD;
    Ok(format!("{}:{}", encoder.encode(iv), encoder.encode(bytes)))
}

async fn setting(db: &mut SqliteConnection, key: &str) -> Result<Option<String>, String> {
    sqlx::query_scalar("SELECT value FROM settings WHERE key = ?")
        .bind(key)
        .fetch_optional(db)
        .await
        .map_err(db_error)
}

async fn secure_setting(db: &mut SqliteConnection, key: &str) -> Result<Option<String>, String> {
    setting(db, key)
        .await?
        .map(|value| decrypt(&value))
        .transpose()
}

fn db_error(error: sqlx::Error) -> String {
    format!("mail database: {error}")
}
fn truncate(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

fn error_category(error: &str) -> &'static str {
    let lower = error.to_ascii_lowercase();
    if lower.contains("credential") || lower.contains("keychain") || lower.contains("encrypt") { return "credential unavailable"; }
    if lower.contains("database") || lower.contains("sqlite") { return "mail database unavailable"; }
    if lower.contains("gmail rate limited") { return "Gmail API rate limited"; }
    if lower.contains("oauth invalid_grant") { return "provider OAuth invalid_grant"; }
    if lower.contains("oauth invalid_client") { return "provider OAuth invalid_client"; }
    if lower.contains("oauth unauthorized_client") { return "provider OAuth unauthorized_client"; }
    if lower.contains("token refresh") || lower.contains("gmail returned http") {
        for (code, category) in [
            (400, "provider HTTP 400"), (401, "provider HTTP 401"),
            (403, "provider HTTP 403"), (408, "provider HTTP 408"),
            (429, "provider HTTP 429"), (500, "provider HTTP 500"),
            (502, "provider HTTP 502"), (503, "provider HTTP 503"),
            (504, "provider HTTP 504"),
        ] {
            if lower.contains(&format!("http {code}")) { return category; }
        }
        if lower.contains("http ") { return "provider HTTP error"; }
    }
    if lower.contains("request failed") || lower.contains("refresh gmail token:") || lower.contains("imap oauth refresh:") || lower.contains("timed out") {
        return "provider network unavailable";
    }
    if lower.contains("auth") || lower.contains("unauthorized") || lower.contains("401") { return "provider authentication failed"; }
    if lower.contains("gmail") || lower.contains("imap") || lower.contains("relay") { return "mail provider unavailable"; }
    "background sync failed"
}

fn gmail_retry_delay(attempt: u32, retry_after_secs: Option<u64>, jitter_ms: u64) -> Duration {
    let base_secs = 1_u64 << attempt.min(5);
    let requested_secs = base_secs.max(retry_after_secs.unwrap_or(0));
    Duration::from_millis(
        (requested_secs.saturating_mul(1_000) + jitter_ms.min(999)).min(GMAIL_MAX_BACKOFF_MS),
    )
}

async fn pace_gmail_get() {
    if std::env::var("SNDMAIL_WORKER_FIXTURE").as_deref() == Ok("1") {
        return;
    }
    static NEXT_GET: std::sync::OnceLock<tokio::sync::Mutex<Option<tokio::time::Instant>>> =
        std::sync::OnceLock::new();
    let mut next = NEXT_GET.get_or_init(|| tokio::sync::Mutex::new(None)).lock().await;
    if let Some(instant) = *next {
        tokio::time::sleep_until(instant).await;
    }
    *next = Some(tokio::time::Instant::now() + GMAIL_GET_SPACING);
}

async fn gmail_rate_limited(response: reqwest::Response) -> bool {
    let mut stream = response.bytes_stream();
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        let Ok(chunk) = chunk else { return false; };
        if body.len().saturating_add(chunk.len()) > 8_192 { return false; }
        body.extend_from_slice(&chunk);
    }
    let Ok(payload) = serde_json::from_slice::<Value>(&body) else { return false; };
    is_gmail_rate_reason(&payload)
}

fn is_gmail_rate_reason(payload: &Value) -> bool {
    payload["error"]["errors"]
        .as_array()
        .is_some_and(|errors| errors.iter().any(|error| {
            matches!(error["reason"].as_str(), Some("rateLimitExceeded" | "userRateLimitExceeded"))
        }))
}

fn oauth_refresh_error(provider: &str, status: reqwest::StatusCode, payload: Option<&Value>) -> String {
    let code = payload.and_then(|value| value.get("error")).and_then(Value::as_str);
    match code {
        Some(code @ ("invalid_grant" | "invalid_client" | "unauthorized_client")) =>
            format!("{provider} OAuth {code}"),
        _ => format!("{provider} token refresh returned HTTP {}", status.as_u16()),
    }
}

async fn set_status(context: &WorkerContext, db: &mut SqliteConnection, phase: &str, account: Option<&str>, error: Option<&str>) -> Result<(), String> {
    sqlx::query("INSERT INTO worker_mail_status (id, phase, account_id, error, updated_at) VALUES (1, ?, ?, ?, unixepoch()) ON CONFLICT(id) DO UPDATE SET phase = excluded.phase, account_id = excluded.account_id, error = excluded.error, updated_at = excluded.updated_at")
        .bind(phase).bind(account).bind(error).execute(&mut *db).await.map_err(db_error)?;
    persist_file_status(context, phase, account, error);
    Ok(())
}

fn persist_file_status(context: &WorkerContext, phase: &str, account: Option<&str>, error: Option<&str>) {
    let Ok(dir) = context.data_dir() else { return; };
    let status = serde_json::json!({
        "phase": phase,
        "accountId": account.map(|v| truncate(v, 256)),
        "error": error.map(|v| truncate(v, 180)),
        "updatedAt": Utc::now().timestamp(),
    });
    let temporary = dir.join(format!("worker-status.{}.tmp", std::process::id()));
    if std::fs::write(&temporary, status.to_string()).is_ok() {
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600));
        }
        let _ = std::fs::rename(temporary, dir.join("worker-status.json"));
    }
}

fn fixture_endpoint(name: &str, production: &str) -> String {
    if std::env::var("SNDMAIL_WORKER_FIXTURE").as_deref() == Ok("1") {
        if let Ok(value) = std::env::var(name) {
            if let Ok(url) = reqwest::Url::parse(&value) {
                if url.scheme() == "http"
                    && matches!(url.host_str(), Some("127.0.0.1" | "localhost"))
                {
                    return value.trim_end_matches('/').to_owned();
                }
            }
        }
    }
    production.to_owned()
}

async fn pending(db: &mut SqliteConnection, account: &str, thread: &str) -> Result<bool, String> {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pending_operations WHERE account_id = ? AND resource_id = ? AND status IN ('pending', 'retrying')")
        .bind(account).bind(thread).fetch_one(db).await.map_err(db_error)?;
    Ok(count > 0)
}

async fn mark_sync(
    db: &mut SqliteConnection,
    account: &str,
    history: Option<&str>,
) -> Result<(), String> {
    sqlx::query("UPDATE accounts SET history_id = COALESCE(?, history_id), last_sync_at = unixepoch(), updated_at = unixepoch() WHERE id = ?")
        .bind(history).bind(account).execute(db).await.map_err(db_error)?;
    Ok(())
}

async fn gmail_token(
    db: &mut SqliteConnection,
    http: &reqwest::Client,
    account: &mut Account,
) -> Result<String, String> {
    // Registration and mail sync use separate SQLite connections. Serialize
    // refreshes, then reload the durable token under the lock so a rotating
    // refresh token cannot be spent twice at startup.
    type RefreshLocks = tokio::sync::Mutex<HashMap<String, std::sync::Arc<tokio::sync::Mutex<()>>>>;
    static REFRESH_LOCKS: std::sync::OnceLock<RefreshLocks> = std::sync::OnceLock::new();
    let account_lock = {
        let mut locks = REFRESH_LOCKS.get_or_init(|| tokio::sync::Mutex::new(HashMap::new())).lock().await;
        locks.entry(account.id.clone()).or_insert_with(|| std::sync::Arc::new(tokio::sync::Mutex::new(()))).clone()
    };
    let _refresh_guard = account_lock.lock().await;
    let previous_access = account.access_token.as_deref().map(decrypt).transpose()?;
    let force_refresh = account.token_expires_at == 0;
    let row = sqlx::query("SELECT access_token, refresh_token, token_expires_at FROM accounts WHERE id = ?")
        .bind(&account.id).fetch_one(&mut *db).await.map_err(db_error)?;
    account.access_token = row.get("access_token");
    account.refresh_token = row.get("refresh_token");
    account.token_expires_at = row.get::<Option<i64>, _>("token_expires_at").unwrap_or(0);
    let old = account
        .access_token
        .as_deref()
        .ok_or("Gmail access token missing")?;
    let old = decrypt(old)?;
    if account.token_expires_at > Utc::now().timestamp() + 300
        && (!force_refresh || Some(old.clone()) != previous_access) {
        return Ok(old);
    }
    let refresh = decrypt(
        account
            .refresh_token
            .as_deref()
            .ok_or("Gmail refresh token missing")?,
    )?;
    let client_id = setting(db, "google_client_id")
        .await?
        .ok_or("Google client ID missing")?;
    let client_secret = secure_setting(db, "google_client_secret").await?;
    let mut form = vec![
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh.as_str()),
        ("client_id", client_id.as_str()),
    ];
    if let Some(ref secret) = client_secret {
        form.push(("client_secret", secret.as_str()));
    }
    let token_url = fixture_endpoint(
        "SNDMAIL_WORKER_TOKEN_URL",
        "https://oauth2.googleapis.com/token",
    );
    let response = http
        .post(token_url)
        .form(&form)
        .send()
        .await
        .map_err(|e| format!("refresh Gmail token: {e}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let payload = response.json::<Value>().await.ok();
        return Err(oauth_refresh_error("Gmail", status, payload.as_ref()));
    }
    let payload: Value = response
        .json()
        .await
        .map_err(|_| "invalid Gmail token response".to_string())?;
    let token = payload["access_token"]
        .as_str()
        .ok_or("Gmail token response missing access token")?
        .to_owned();
    let expires = Utc::now().timestamp() + payload["expires_in"].as_i64().unwrap_or(3600);
    let encrypted = encrypt(&token)?;
    let rotated = payload["refresh_token"].as_str().map(encrypt).transpose()?;
    sqlx::query("UPDATE accounts SET access_token = ?, refresh_token = COALESCE(?, refresh_token), token_expires_at = ?, updated_at = unixepoch() WHERE id = ?")
        .bind(encrypted).bind(&rotated).bind(expires).bind(&account.id).execute(&mut *db).await.map_err(db_error)?;
    account.access_token = Some(token.clone());
    if let Some(rotated) = rotated { account.refresh_token = Some(rotated); }
    account.token_expires_at = expires;
    Ok(token)
}

async fn gmail_get(
    http: &reqwest::Client,
    token: &str,
    path: &str,
) -> Result<Option<Value>, String> {
    let base = fixture_endpoint("SNDMAIL_WORKER_GMAIL_URL", GMAIL);
    for attempt in 0..=GMAIL_MAX_RETRIES {
        pace_gmail_get().await;
        let response = http
            .get(format!("{base}{path}"))
            .bearer_auth(token)
            .send()
            .await
            .map_err(|e| format!("Gmail request failed: {e}"))?;
        let status = response.status();
        if status == reqwest::StatusCode::NOT_FOUND { return Ok(None); }
        if status == reqwest::StatusCode::UNAUTHORIZED { return Err("GMAIL_UNAUTHORIZED".into()); }
        if status.is_success() {
            return response.json().await.map(Some)
                .map_err(|_| "invalid Gmail JSON response".to_string());
        }
        let retry_after = response.headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok());
        let rate_limited = status == reqwest::StatusCode::TOO_MANY_REQUESTS
            || (status == reqwest::StatusCode::FORBIDDEN && gmail_rate_limited(response).await);
        if (rate_limited || status.is_server_error()) && attempt < GMAIL_MAX_RETRIES {
            let jitter = SystemTime::now().duration_since(UNIX_EPOCH)
                .map(|duration| u64::from(duration.subsec_millis()) % 1_000).unwrap_or(0);
            tokio::time::sleep(gmail_retry_delay(attempt, retry_after, jitter)).await;
            continue;
        }
        if rate_limited { return Err("Gmail rate limited".into()); }
        return Err(format!("Gmail returned HTTP {status}"));
    }
    Err("Gmail rate limited".into())
}

async fn sync_gmail(
    db: &mut SqliteConnection,
    http: &reqwest::Client,
    account: &mut Account,
    force_full: bool,
) -> Result<bool, String> {
    match sync_gmail_once(db, http, account, force_full).await {
        Err(error) if error == "GMAIL_UNAUTHORIZED" => {
            account.token_expires_at = 0;
            sync_gmail_once(db, http, account, force_full).await
        }
        result => result,
    }
}

async fn sync_gmail_once(
    db: &mut SqliteConnection,
    http: &reqwest::Client,
    account: &mut Account,
    force_full: bool,
) -> Result<bool, String> {
    let token = gmail_token(db, http, account).await?;
    let mut changed = false;
    let mut affected = HashSet::<String>::new();
    let mut new_inbox = HashSet::<String>::new();
    let mut newest_history = None;
    let mut initial = force_full || account.history_id.is_none();
    let mut deferred = false;

    if !force_full { if let Some(history) = account.history_id.as_deref() {
        let mut page: Option<String> = None;
        loop {
            let mut path = format!("/history?startHistoryId={history}&historyTypes=messageAdded&historyTypes=messageDeleted&historyTypes=labelAdded&historyTypes=labelRemoved");
            if let Some(ref token) = page {
                path.push_str("&pageToken=");
                path.push_str(token);
            }
            match gmail_get(http, &token, &path).await? {
                Some(response) => {
                    newest_history = response["historyId"].as_str().map(str::to_owned);
                    if let Some(items) = response["history"].as_array() {
                        for item in items {
                            for field in [
                                "messagesAdded",
                                "messagesDeleted",
                                "labelsAdded",
                                "labelsRemoved",
                            ] {
                                if let Some(events) = item[field].as_array() {
                                    for event in events {
                                        if let Some(id) = event["message"]["threadId"].as_str() {
                                            affected.insert(id.to_owned());
                                        }
                                        if field == "messagesAdded" {
                                            let labels = event["message"]["labelIds"].as_array();
                                            let inbox = labels.is_some_and(|items| items.iter().any(|v| v.as_str() == Some("INBOX")));
                                            let unread = labels.is_some_and(|items| items.iter().any(|v| v.as_str() == Some("UNREAD")));
                                            if inbox && unread {
                                                if let Some(id) = event["message"]["id"].as_str() { new_inbox.insert(id.to_owned()); }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    page = response["nextPageToken"].as_str().map(str::to_owned);
                    if page.is_none() {
                        break;
                    }
                }
                None => {
                    initial = true;
                    break;
                } // Expired History ID (HTTP 404).
            }
        }
    }}

    if initial {
        new_inbox.clear(); // Initial/expired-history scan is a baseline.
        // Capture a starting point before the scan, then the next History
        // cycle catches changes made during it. Preserve old rows on failure.
        let profile = gmail_get(http, &token, "/profile")
            .await?
            .ok_or("Gmail profile unavailable")?;
        newest_history = profile["historyId"].as_str().map(str::to_owned);
        let days: u32 = setting(db, "sync_period_days")
            .await?
            .and_then(|v| v.parse().ok())
            .unwrap_or(365);
        let mut page: Option<String> = None;
        loop {
            let mut path = format!("/threads?maxResults=100&includeSpamTrash=true&q=newer_than%3A{days}d");
            if let Some(ref token) = page {
                path.push_str("&pageToken=");
                path.push_str(token);
            }
            let response = gmail_get(http, &token, &path)
                .await?
                .ok_or("Gmail thread list unavailable")?;
            if let Some(threads) = response["threads"].as_array() {
                for item in threads {
                    if let Some(id) = item["id"].as_str() {
                        affected.insert(id.to_owned());
                    }
                }
            }
            if affected.len() > MAX_INITIAL_THREADS {
                return Err("Gmail initial sync exceeded safe thread limit".into());
            }
            page = response["nextPageToken"].as_str().map(str::to_owned);
            if page.is_none() {
                break;
            }
        }
        sync_gmail_labels(db, http, &token, &account.id).await?;
    }

    // History can expire before the worker runs again. A complete bounded
    // scan is then the authority for recent cached threads; older mail is
    // outside the configured scan window and must remain untouched.
    let expired_baseline = ((account.history_id.is_some() || force_full) && initial).then(|| affected.clone());
    for id in affected {
        if pending(db, &account.id, &id).await? {
            deferred = true;
            continue;
        }
        let path = format!("/threads/{id}?format=full");
        match gmail_get(http, &token, &path).await? {
            Some(thread) => {
                store_gmail_thread(db, http, &token, &account.id, &account.email, &id, &thread, &new_inbox).await?;
                changed = true;
            }
            None => {
                // A delete can arrive in History after the thread vanishes.
                delete_gmail_thread(db, &account.id, &id).await?;
                changed = true;
            }
        }
    }
    if let Some(live) = expired_baseline {
        let days: i64 = setting(db, "sync_period_days").await?
            .and_then(|value| value.parse().ok()).unwrap_or(365);
        let cutoff = Utc::now().timestamp_millis() - days.clamp(1, 3650) * 86_400_000;
        let cached: Vec<String> = sqlx::query_scalar(
            "SELECT id FROM threads WHERE account_id = ? AND last_message_at >= ?",
        )
        .bind(&account.id).bind(cutoff).fetch_all(&mut *db).await.map_err(db_error)?;
        for id in cached {
            if !live.contains(&id) {
                if pending(db, &account.id, &id).await? { deferred = true; continue; }
                delete_gmail_thread(db, &account.id, &id).await?;
                changed = true;
            }
        }
    }
    // Keep the old History ID while any affected thread has a queued local
    // action. Otherwise that server change could be lost forever.
    mark_sync(
        db,
        &account.id,
        if deferred {
            None
        } else {
            newest_history.as_deref()
        },
    )
    .await?;
    Ok(changed)
}

async fn delete_gmail_thread(db: &mut SqliteConnection, account: &str, thread: &str) -> Result<(), String> {
    sqlx::query("BEGIN IMMEDIATE").execute(&mut *db).await.map_err(db_error)?;
    let result = async {
        sqlx::query("DELETE FROM attachments WHERE account_id = ? AND message_id IN (SELECT id FROM messages WHERE account_id = ? AND thread_id = ?)")
            .bind(account).bind(account).bind(thread).execute(&mut *db).await.map_err(db_error)?;
        sqlx::query("DELETE FROM messages WHERE account_id = ? AND thread_id = ?")
            .bind(account).bind(thread).execute(&mut *db).await.map_err(db_error)?;
        sqlx::query("DELETE FROM thread_labels WHERE account_id = ? AND thread_id = ?")
            .bind(account).bind(thread).execute(&mut *db).await.map_err(db_error)?;
        sqlx::query("DELETE FROM threads WHERE account_id = ? AND id = ?")
            .bind(account).bind(thread).execute(&mut *db).await.map_err(db_error)?;
        Ok::<(), String>(())
    }.await;
    match result {
        Ok(()) => sqlx::query("COMMIT").execute(&mut *db).await.map(|_| ()).map_err(db_error),
        Err(error) => { let _ = sqlx::query("ROLLBACK").execute(&mut *db).await; Err(error) }
    }
}

async fn sync_gmail_labels(
    db: &mut SqliteConnection,
    http: &reqwest::Client,
    token: &str,
    account: &str,
) -> Result<(), String> {
    let response = gmail_get(http, token, "/labels")
        .await?
        .ok_or("Gmail labels unavailable")?;
    if let Some(labels) = response["labels"].as_array() {
        for label in labels {
            let Some(id) = label["id"].as_str() else {
                continue;
            };
            sqlx::query("INSERT INTO labels (id, account_id, name, type, color_bg, color_fg) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(account_id, id) DO UPDATE SET name = excluded.name, type = excluded.type, color_bg = excluded.color_bg, color_fg = excluded.color_fg")
                .bind(id).bind(account).bind(label["name"].as_str().unwrap_or(id))
                .bind(label["type"].as_str().unwrap_or("system"))
                .bind(label["color"]["backgroundColor"].as_str())
                .bind(label["color"]["textColor"].as_str())
                .execute(&mut *db).await.map_err(db_error)?;
        }
    }
    Ok(())
}

fn gmail_header<'a>(message: &'a Value, name: &str) -> Option<&'a str> {
    message["payload"]["headers"].as_array()?.iter().find(|h| {
        h["name"]
            .as_str()
            .is_some_and(|n| n.eq_ignore_ascii_case(name))
    })?["value"]
        .as_str()
}

async fn gmail_body(
    http: &reqwest::Client,
    token: &str,
    message_id: &str,
    part: &Value,
    mime: &str,
) -> Result<Option<String>, String> {
    let Some(candidate) = find_gmail_body_part(part, mime) else {
        return Ok(None);
    };
    if let Some(encoded) = candidate["body"]["data"].as_str() {
        return Ok(decode_gmail_body(encoded));
    }
    // Gmail moves large MIME bodies out of the message payload and exposes
    // them through the same attachment endpoint as files. Only fetch a part
    // selected as text/plain or text/html by the caller.
    if let Some(attachment_id) = candidate["body"]["attachmentId"].as_str() {
        let path = format!("/messages/{message_id}/attachments/{attachment_id}");
        let response = match gmail_get(http, token, &path).await {
            Ok(Some(response)) => response,
            Ok(None) => return Ok(None),
            // Propagate auth, rate-limit, and transport failures so the sync
            // cursor is not advanced after storing a thread without its body.
            Err(error) => return Err(error),
        };
        let Some(encoded) = response["data"].as_str() else { return Ok(None); };
        return Ok(decode_gmail_body(encoded));
    }
    Ok(None)
}

fn find_gmail_body_part<'a>(part: &'a Value, mime: &str) -> Option<&'a Value> {
    let mut stack = vec![part];
    while let Some(candidate) = stack.pop() {
        let has_filename = candidate["filename"].as_str()
            .is_some_and(|filename| !filename.trim().is_empty());
        let is_attachment = candidate["headers"].as_array().is_some_and(|headers| {
            headers.iter().any(|header| {
                header["name"].as_str().is_some_and(|name| name.eq_ignore_ascii_case("Content-Disposition"))
                    && header["value"].as_str().is_some_and(|value| {
                        value.trim_start().to_ascii_lowercase().starts_with("attachment")
                    })
            })
        });
        if !has_filename
            && !is_attachment
            && candidate["mimeType"].as_str() == Some(mime)
            && (candidate["body"]["data"].is_string()
                || candidate["body"]["attachmentId"].is_string())
        {
            return Some(candidate);
        }
        if let Some(children) = candidate["parts"].as_array() {
            // Reverse push keeps the original MIME traversal order.
            stack.extend(children.iter().rev());
        }
    }
    None
}

fn decode_gmail_body(encoded: &str) -> Option<String> {
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(encoded))
        .ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

async fn store_gmail_thread(
    db: &mut SqliteConnection,
    http: &reqwest::Client,
    token: &str,
    account: &str,
    account_email: &str,
    id: &str,
    thread: &Value,
    new_inbox: &HashSet<String>,
) -> Result<(), String> {
    let messages = thread["messages"]
        .as_array()
        .ok_or("Gmail thread has no messages")?;
    if messages.is_empty() {
        return Ok(());
    }
    // Resolve attachment-backed body parts before opening the write transaction
    // so the network request does not hold SQLite's write lock.
    let mut message_bodies = HashMap::new();
    for message in messages {
        let Some(message_id) = message["id"].as_str() else { continue; };
        let html = gmail_body(http, token, message_id, &message["payload"], "text/html").await?;
        let text = gmail_body(http, token, message_id, &message["payload"], "text/plain").await?;
        message_bodies.insert(message_id.to_owned(), (html, text));
    }
    let mut labels = HashSet::new();
    let mut latest = &messages[0];
    let mut earliest = &messages[0];
    let mut all_read = true;
    let mut starred = false;
    for message in messages {
        let date = message["internalDate"]
            .as_str()
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(0);
        if date
            > latest["internalDate"]
                .as_str()
                .and_then(|v| v.parse::<i64>().ok())
                .unwrap_or(0)
        {
            latest = message;
        }
        if date
            < earliest["internalDate"]
                .as_str()
                .and_then(|v| v.parse::<i64>().ok())
                .unwrap_or(i64::MAX)
        {
            earliest = message;
        }
        if let Some(ids) = message["labelIds"].as_array() {
            for value in ids {
                if let Some(label) = value.as_str() {
                    labels.insert(label.to_owned());
                }
            }
        }
        all_read &= !message["labelIds"]
            .as_array()
            .is_some_and(|ids| ids.iter().any(|v| v.as_str() == Some("UNREAD")));
        starred |= message["labelIds"]
            .as_array()
            .is_some_and(|ids| ids.iter().any(|v| v.as_str() == Some("STARRED")));
    }
    let latest_date = latest["internalDate"]
        .as_str()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0);
    let has_attachments = messages.iter().any(|m| gmail_has_attachment(&m["payload"]));
    let previously_stored: HashSet<String> = sqlx::query_scalar("SELECT id FROM messages WHERE account_id = ? AND thread_id = ?")
        .bind(account).bind(id).fetch_all(&mut *db).await.map_err(db_error)?
        .into_iter().collect();
    let muted: i64 = sqlx::query_scalar("SELECT COALESCE(is_muted, 0) FROM threads WHERE account_id = ? AND id = ?")
        .bind(account).bind(id).fetch_optional(&mut *db).await.map_err(db_error)?.unwrap_or(0);
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *db)
        .await
        .map_err(db_error)?;
    let result = async {
        sqlx::query("INSERT INTO threads (id, account_id, subject, snippet, last_message_at, message_count, is_read, is_starred, is_important, has_attachments) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(account_id, id) DO UPDATE SET subject = excluded.subject, snippet = excluded.snippet, last_message_at = excluded.last_message_at, message_count = excluded.message_count, is_read = excluded.is_read, is_starred = excluded.is_starred, is_important = excluded.is_important, has_attachments = excluded.has_attachments")
            .bind(id).bind(account).bind(gmail_header(earliest, "Subject"))
            .bind(latest["snippet"].as_str()).bind(latest_date).bind(messages.len() as i64)
            .bind(all_read as i64).bind(starred as i64).bind(labels.contains("IMPORTANT") as i64)
            .bind(has_attachments as i64).execute(&mut *db).await.map_err(db_error)?;
        let live_ids: HashSet<&str> = messages.iter().filter_map(|m| m["id"].as_str()).collect();
        let stored_ids: Vec<String> = sqlx::query_scalar("SELECT id FROM messages WHERE account_id = ? AND thread_id = ?")
            .bind(account).bind(id).fetch_all(&mut *db).await.map_err(db_error)?;
        for old_id in stored_ids {
            if !live_ids.contains(old_id.as_str()) {
                sqlx::query("DELETE FROM messages WHERE account_id = ? AND id = ?")
                    .bind(account).bind(&old_id).execute(&mut *db).await.map_err(db_error)?;
            }
        }
        for message in messages {
            let Some(message_id) = message["id"].as_str() else { continue; };
            let (html, text) = message_bodies.get(message_id).cloned().unwrap_or_default();
            store_gmail_message(db, account, id, message, html, text).await?;
        }
        sqlx::query("DELETE FROM thread_labels WHERE account_id = ? AND thread_id = ?")
            .bind(account).bind(id).execute(&mut *db).await.map_err(db_error)?;
        for label in labels {
            if label == "INBOX" && messages.iter().any(|m| m["labelIds"].as_array().is_some_and(|ids| ids.iter().any(|v| v.as_str() == Some("SPAM")))) { continue; }
            sqlx::query("INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id) VALUES (?, ?, ?)")
                .bind(account).bind(id).bind(label).execute(&mut *db).await.map_err(db_error)?;
        }
        Ok::<(), String>(())
    }.await;
    match result {
        Ok(()) => {
            sqlx::query("COMMIT").execute(&mut *db).await.map_err(db_error)?;
            for message in messages {
                let Some(message_id) = message["id"].as_str() else { continue; };
                if !new_inbox.contains(message_id) || previously_stored.contains(message_id) || muted != 0 { continue; }
                let inbox = message["labelIds"].as_array().is_some_and(|ids| ids.iter().any(|v| v.as_str() == Some("INBOX")));
                if !inbox { continue; }
                sqlx::query("INSERT OR IGNORE INTO worker_postprocess_queue (account_id, message_id) VALUES (?, ?)")
                    .bind(account).bind(message_id).execute(&mut *db).await.map_err(db_error)?;
                if message["labelIds"].as_array().is_some_and(|ids| ids.iter().any(|v| matches!(v.as_str(), Some("SPAM" | "TRASH")))) { continue; }
                let from = gmail_header(message, "From");
                if split_address(from).1.is_some_and(|address| address.eq_ignore_ascii_case(account_email)) { continue; }
                let date = message["internalDate"].as_str().and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
                let bodies = message_bodies.get(message_id);
                let body = bodies.and_then(|(html, text)| text.as_ref().or(html.as_ref()));
                let body_html = bodies.and_then(|(html, _)| html.as_deref());
                otp::maybe_notify(db, account, id, message_id, gmail_header(message, "Subject"), body.map(String::as_str), body_html, date, gmail_header(message, "From")).await?;
                otp::maybe_notify_mail(db, account, id, message_id, gmail_header(message, "Subject"), body.map(String::as_str), date,
                    split_address(gmail_header(message, "From")).1).await?;
            }
            Ok(())
        },
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *db).await;
            Err(error)
        }
    }
}

fn gmail_has_attachment(part: &Value) -> bool {
    part["body"]["attachmentId"].as_str().is_some()
        || part["parts"]
            .as_array()
            .is_some_and(|parts| parts.iter().any(gmail_has_attachment))
}

async fn store_gmail_message(
    db: &mut SqliteConnection,
    account: &str,
    thread: &str,
    message: &Value,
    html: Option<String>,
    text: Option<String>,
) -> Result<(), String> {
    let Some(id) = message["id"].as_str() else {
        return Ok(());
    };
    let from = gmail_header(message, "From");
    let (from_name, from_address) = split_address(from);
    let date = message["internalDate"]
        .as_str()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0);
    let read = !message["labelIds"]
        .as_array()
        .is_some_and(|ids| ids.iter().any(|v| v.as_str() == Some("UNREAD")));
    let starred = message["labelIds"]
        .as_array()
        .is_some_and(|ids| ids.iter().any(|v| v.as_str() == Some("STARRED")));
    sqlx::query("INSERT INTO messages (id, account_id, thread_id, from_address, from_name, to_addresses, cc_addresses, bcc_addresses, reply_to, subject, snippet, date, is_read, is_starred, body_html, body_text, body_cached, raw_size, internal_date, list_unsubscribe, list_unsubscribe_post, message_id_header, references_header, in_reply_to_header, disposition_notification_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(account_id, id) DO UPDATE SET from_address = excluded.from_address, from_name = excluded.from_name, to_addresses = excluded.to_addresses, cc_addresses = excluded.cc_addresses, bcc_addresses = excluded.bcc_addresses, reply_to = excluded.reply_to, subject = excluded.subject, snippet = excluded.snippet, date = excluded.date, is_read = excluded.is_read, is_starred = excluded.is_starred, body_html = COALESCE(excluded.body_html, messages.body_html), body_text = COALESCE(excluded.body_text, messages.body_text), body_cached = MAX(messages.body_cached, excluded.body_cached), raw_size = excluded.raw_size, internal_date = excluded.internal_date, list_unsubscribe = excluded.list_unsubscribe, list_unsubscribe_post = excluded.list_unsubscribe_post, message_id_header = COALESCE(excluded.message_id_header, messages.message_id_header), references_header = COALESCE(excluded.references_header, messages.references_header), in_reply_to_header = COALESCE(excluded.in_reply_to_header, messages.in_reply_to_header), disposition_notification_to = COALESCE(excluded.disposition_notification_to, messages.disposition_notification_to)")
        .bind(id).bind(account).bind(thread).bind(from_address).bind(from_name)
        .bind(gmail_header(message, "To")).bind(gmail_header(message, "Cc")).bind(gmail_header(message, "Bcc"))
        .bind(gmail_header(message, "Reply-To")).bind(gmail_header(message, "Subject"))
        .bind(message["snippet"].as_str()).bind(date).bind(read as i64).bind(starred as i64)
        .bind(html.as_deref()).bind(text.as_deref()).bind((html.is_some() || text.is_some()) as i64)
        .bind(message["sizeEstimate"].as_i64()).bind(date)
        .bind(gmail_header(message, "List-Unsubscribe")).bind(gmail_header(message, "List-Unsubscribe-Post"))
        .bind(gmail_header(message, "Message-ID")).bind(gmail_header(message, "References"))
        .bind(gmail_header(message, "In-Reply-To")).bind(gmail_header(message, "Disposition-Notification-To"))
        .execute(&mut *db).await.map_err(db_error)?;
    store_gmail_attachments(db, account, id, &message["payload"]).await?;
    Ok(())
}

async fn store_gmail_attachments(
    db: &mut SqliteConnection,
    account: &str,
    id: &str,
    payload: &Value,
) -> Result<(), String> {
    let mut stack = vec![payload];
    while let Some(part) = stack.pop() {
        if let Some(attachment_id) = part["body"]["attachmentId"].as_str() {
            let filename = part["filename"].as_str().unwrap_or("");
            if !filename.is_empty() {
                sqlx::query("INSERT INTO attachments (id, message_id, account_id, filename, mime_type, size, gmail_attachment_id) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET filename = excluded.filename, mime_type = excluded.mime_type, size = excluded.size")
                    .bind(format!("{id}_{attachment_id}")).bind(id).bind(account).bind(filename)
                    .bind(part["mimeType"].as_str()).bind(part["body"]["size"].as_i64())
                    .bind(attachment_id).execute(&mut *db).await.map_err(db_error)?;
            }
        }
        if let Some(parts) = part["parts"].as_array() {
            stack.extend(parts);
        }
    }
    Ok(())
}

fn split_address(raw: Option<&str>) -> (Option<&str>, Option<&str>) {
    let Some(raw) = raw else {
        return (None, None);
    };
    if let Some((name, rest)) = raw.rsplit_once('<') {
        if let Some(address) = rest.strip_suffix('>') {
            let name = name.trim().trim_matches('"').trim();
            return (
                if name.is_empty() { None } else { Some(name) },
                Some(address.trim()),
            );
        }
    }
    (None, Some(raw.trim()))
}

fn imap_config(account: &Account) -> Result<ImapConfig, String> {
    let host = account.imap_host.as_deref().ok_or("IMAP host missing")?;
    let password = if account.auth_method == "oauth2" {
        // OAuth2 mailboxes use their current encrypted access token. Refresh
        // above persists and replaces it before the IMAP connection opens.
        decrypt(
            account
                .access_token
                .as_deref()
                .ok_or("IMAP OAuth token missing")?,
        )?
    } else {
        decrypt(
            account
                .imap_password
                .as_deref()
                .ok_or("IMAP password missing")?,
        )?
    };
    Ok(ImapConfig {
        host: host.to_owned(),
        port: account.imap_port,
        security: match account.imap_security.as_str() {
            "ssl" | "tls" => "tls",
            "starttls" => "starttls",
            "none" => "none",
            _ => "tls",
        }
        .to_owned(),
        username: account
            .imap_username
            .clone()
            .unwrap_or_else(|| account.email.clone()),
        password,
        auth_method: if account.auth_method == "oauth2" {
            "oauth2"
        } else {
            "password"
        }
        .into(),
        accept_invalid_certs: account.accept_invalid_certs,
    })
}

async fn fresh_imap_token(db: &mut SqliteConnection, http: &reqwest::Client, account: &mut Account) -> Result<(), String> {
    if account.auth_method != "oauth2" { return Ok(()); }
    if account.token_expires_at > Utc::now().timestamp() + 300 { return Ok(()); }
    let provider = account.oauth_provider.as_deref().ok_or("IMAP OAuth provider missing")?;
    let (url, scope) = match provider {
        "microsoft" => ("https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
            Some("https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access openid profile email")),
        "yahoo" => ("https://api.login.yahoo.com/oauth2/get_token", None),
        _ => return Err("unsupported IMAP OAuth provider".into()),
    };
    let url = fixture_endpoint("SNDMAIL_WORKER_TOKEN_URL", url);
    let refresh = decrypt(account.refresh_token.as_deref().ok_or("IMAP refresh token missing")?)?;
    let client_id = account.oauth_client_id.as_deref().ok_or("IMAP OAuth client ID missing")?;
    let secret = account.oauth_client_secret.as_deref().map(decrypt).transpose()?;
    let mut form = vec![("refresh_token", refresh.as_str()), ("client_id", client_id), ("grant_type", "refresh_token")];
    if let Some(ref secret) = secret { if !secret.is_empty() { form.push(("client_secret", secret.as_str())); } }
    if let Some(scope) = scope { form.push(("scope", scope)); }
    let response = http.post(url).form(&form).send().await.map_err(|e| format!("IMAP OAuth refresh: {e}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let payload = response.json::<Value>().await.ok();
        return Err(oauth_refresh_error("IMAP", status, payload.as_ref()));
    }
    let payload: Value = response.json().await.map_err(|_| "invalid IMAP OAuth response".to_string())?;
    let access = payload["access_token"].as_str().ok_or("IMAP OAuth response missing access token")?;
    let rotated = payload["refresh_token"].as_str();
    let expires = Utc::now().timestamp() + payload["expires_in"].as_i64().unwrap_or(3600);
    let enc_access = encrypt(access)?;
    let enc_refresh = rotated.map(encrypt).transpose()?;
    sqlx::query("UPDATE accounts SET access_token = ?, refresh_token = COALESCE(?, refresh_token), token_expires_at = ?, updated_at = unixepoch() WHERE id = ?")
        .bind(&enc_access).bind(&enc_refresh).bind(expires).bind(&account.id).execute(&mut *db).await.map_err(db_error)?;
    account.access_token = Some(enc_access);
    if let Some(rotated) = enc_refresh { account.refresh_token = Some(rotated); }
    account.token_expires_at = expires;
    Ok(())
}

async fn watch_imap_idle(context: WorkerContext, account_id: String, config: ImapConfig) {
    let shutdown = context.shutdown();
    loop {
        if shutdown.is_cancelled() {
            return;
        }
        let outcome = async {
            let mut session = imap::connect(&config).await?;
            session
                .select("INBOX")
                .await
                .map_err(|e| format!("IMAP IDLE select: {e}"))?;
            loop {
                let mut handle = session.idle();
                handle
                    .init()
                    .await
                    .map_err(|e| format!("IMAP IDLE start: {e}"))?;
                let (wait, stop) = handle.wait_with_timeout(Duration::from_secs(25 * 60));
                let result = tokio::select! {
                    value = wait => Some(value),
                    _ = shutdown.cancelled() => { drop(stop); None },
                };
                session = handle
                    .done()
                    .await
                    .map_err(|e| format!("IMAP IDLE stop: {e}"))?;
                match result {
                    Some(Ok(IdleResponse::NewData(_))) => {
                        context.notify_mail_changed(account_id.clone())
                    }
                    Some(Ok(IdleResponse::Timeout)) => {}
                    Some(Ok(IdleResponse::ManualInterrupt)) | None => return Ok::<(), String>(()),
                    Some(Err(error)) => return Err(format!("IMAP IDLE wait: {error}")),
                }
            }
        }
        .await;
        if let Err(error) = outcome {
            log::warn!(
                "IMAP IDLE reconnecting: {}",
                error_category(&error)
            );
        }
        // A dropped socket or laptop wake also gets a catch-up sync before
        // IDLE is re-established. Backoff avoids hammering a refused server.
        context.notify_mail_changed(account_id.clone());
        tokio::select! {
            _ = shutdown.cancelled() => return,
            _ = tokio::time::sleep(Duration::from_secs(30)) => {},
        }
    }
}

async fn sync_imap(db: &mut SqliteConnection, http: &reqwest::Client, account: &mut Account, force_full: bool) -> Result<bool, String> {
    fresh_imap_token(db, http, account).await?;
    let config = imap_config(account)?;
    let mut session = imap::connect(&config).await?;
    let folders = imap::list_folders(&mut session).await?;
    let days: i64 = setting(db, "sync_period_days")
        .await?
        .and_then(|v| v.parse().ok())
        .unwrap_or(365);
    let since = (Utc::now() - ChronoDuration::days(days + 1)).date_naive();
    let since = format!("{:02}-{}-{}", since.day(), since.format("%b"), since.year());
    let mut changed = false;
    for folder in folders {
        if matches!(
            folder.path.to_ascii_lowercase().as_str(),
            "[gmail]" | "[google mail]"
        ) {
            continue;
        }
        upsert_imap_label(db, &account.id, &folder).await?;
        let previous = sqlx::query("SELECT uidvalidity, last_uid, modseq FROM folder_sync_state WHERE account_id = ? AND folder_path = ?")
            .bind(&account.id).bind(&folder.raw_path).fetch_optional(&mut *db).await.map_err(db_error)?;
        let (old_validity, last_uid) = previous
            .as_ref()
            .map(|r| {
                (
                    r.get::<Option<i64>, _>("uidvalidity").unwrap_or(0),
                    r.get::<Option<i64>, _>("last_uid").unwrap_or(0),
                )
            })
            .unwrap_or((0, 0));
        let status = imap::get_folder_status(&mut session, &folder.raw_path).await?;
        let old_modseq = previous
            .as_ref()
            .and_then(|r| r.get::<Option<i64>, _>("modseq"));
        let validity_changed = old_validity != 0 && old_validity != status.uidvalidity as i64;
        let initial = previous.is_none() || validity_changed || force_full;
        if validity_changed {
            let blocked: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM messages m JOIN pending_operations p ON p.account_id = m.account_id AND p.resource_id = m.thread_id WHERE m.account_id = ? AND m.imap_folder = ? AND p.status IN ('pending', 'retrying')")
                .bind(&account.id).bind(&folder.raw_path).fetch_one(&mut *db).await.map_err(db_error)?;
            if blocked > 0 {
                continue;
            }
        }
        let messages = if initial {
            imap::sync_folder(
                &mut session,
                &folder.raw_path,
                BATCH_SIZE as u32,
                Some(since.clone()),
            )
            .await?
            .messages
        } else {
            let uids =
                imap::fetch_new_uids(&mut session, &folder.raw_path, last_uid as u32).await?;
            let mut result = Vec::new();
            for chunk in uids.chunks(BATCH_SIZE) {
                let set = chunk
                    .iter()
                    .map(u32::to_string)
                    .collect::<Vec<_>>()
                    .join(",");
                result.extend(
                    imap::fetch_messages(&mut session, &folder.raw_path, &set)
                        .await?
                        .messages,
                );
            }
            result
        };
        if validity_changed {
            // UID numbers can now refer to different messages. Replace the
            // entire folder only after its fetch succeeded, in one SQLite
            // transaction so parse/store failure preserves the old cache.
            sqlx::query("BEGIN IMMEDIATE").execute(&mut *db).await.map_err(db_error)?;
            let replacement = async {
                let old_threads: Vec<String> = sqlx::query_scalar("SELECT DISTINCT thread_id FROM messages WHERE account_id = ? AND imap_folder = ?")
                    .bind(&account.id).bind(&folder.raw_path).fetch_all(&mut *db).await.map_err(db_error)?;
                sqlx::query("DELETE FROM attachments WHERE account_id = ? AND message_id IN (SELECT id FROM messages WHERE account_id = ? AND imap_folder = ?)")
                    .bind(&account.id).bind(&account.id).bind(&folder.raw_path).execute(&mut *db).await.map_err(db_error)?;
                sqlx::query("DELETE FROM messages WHERE account_id = ? AND imap_folder = ?")
                    .bind(&account.id).bind(&folder.raw_path).execute(&mut *db).await.map_err(db_error)?;
                let mut max_uid = 0_i64;
                for message in &messages {
                    let thread = imap_thread_id(db, &account.id, message).await?;
                    if pending(db, &account.id, &thread).await? {
                        return Err("IMAP UIDVALIDITY replacement has pending local operation".into());
                    }
                    store_imap_message(db, &account.id, &folder, &thread, message, true).await?;
                    max_uid = max_uid.max(message.uid as i64);
                }
                for thread in old_threads { recompute_imap_thread(db, &account.id, &thread).await?; }
                sqlx::query("INSERT INTO folder_sync_state (account_id, folder_path, uidvalidity, last_uid, modseq, last_sync_at) VALUES (?, ?, ?, ?, ?, unixepoch()) ON CONFLICT(account_id, folder_path) DO UPDATE SET uidvalidity = excluded.uidvalidity, last_uid = excluded.last_uid, modseq = excluded.modseq, last_sync_at = excluded.last_sync_at")
                    .bind(&account.id).bind(&folder.raw_path).bind(status.uidvalidity as i64).bind(max_uid)
                    .bind(status.highest_modseq.map(|v| v as i64))
                    .execute(&mut *db).await.map_err(db_error)?;
                Ok::<(), String>(())
            }.await;
            match replacement {
                Ok(()) => { sqlx::query("COMMIT").execute(&mut *db).await.map_err(db_error)?; }
                Err(error) => { let _ = sqlx::query("ROLLBACK").execute(&mut *db).await; return Err(error); }
            }
            changed = true;
            continue;
        }
        let mut max_uid = if initial { 0 } else { last_uid };
        let mut deferred = false;
        for message in messages {
            let thread = imap_thread_id(db, &account.id, &message).await?;
            if pending(db, &account.id, &thread).await? {
                deferred = true;
                continue;
            }
            store_imap_message(db, &account.id, &folder, &thread, &message, false).await?;
            let muted: i64 = sqlx::query_scalar("SELECT COALESCE(is_muted, 0) FROM threads WHERE account_id = ? AND id = ?")
                .bind(&account.id).bind(&thread).fetch_optional(&mut *db).await.map_err(db_error)?.unwrap_or(0);
            let self_sent = message.from_address.as_deref().is_some_and(|from| from.eq_ignore_ascii_case(&account.email));
            if !initial && folder_label(&folder).0 == "INBOX" && !message.is_read && muted == 0 && !self_sent {
                let id = format!("imap-{}-{}-{}", account.id, message.folder, message.uid);
                sqlx::query("INSERT OR IGNORE INTO worker_postprocess_queue (account_id, message_id) VALUES (?, ?)")
                    .bind(&account.id).bind(&id).execute(&mut *db).await.map_err(db_error)?;
            }
            if !initial && folder_label(&folder).0 == "INBOX" && !message.is_read && muted == 0 && !self_sent {
                let id = format!("imap-{}-{}-{}", account.id, message.folder, message.uid);
                otp::maybe_notify(db, &account.id, &thread, &id, message.subject.as_deref(),
                    message.body_text.as_deref().or(message.body_html.as_deref()),
                    message.body_html.as_deref(),
                    message.date * 1000, message.from_name.as_deref().or(message.from_address.as_deref())).await?;
                otp::maybe_notify_mail(db, &account.id, &thread, &id, message.subject.as_deref(),
                    message.body_text.as_deref().or(message.body_html.as_deref()), message.date * 1000,
                    message.from_address.as_deref()).await?;
            }
            max_uid = max_uid.max(message.uid as i64);
            changed = true;
        }
        // Do not advance past messages withheld by local pending operations:
        // replay them on the next cycle after the queue drains.
        if !validity_changed && (!initial || force_full) {
            changed |= reconcile_imap_folder(
                db,
                &mut session,
                &account.id,
                &folder,
                old_modseq.is_none() || old_modseq != status.highest_modseq.map(|v| v as i64),
            )
            .await?;
        }
        if !deferred {
            sqlx::query("INSERT INTO folder_sync_state (account_id, folder_path, uidvalidity, last_uid, modseq, last_sync_at) VALUES (?, ?, ?, ?, ?, unixepoch()) ON CONFLICT(account_id, folder_path) DO UPDATE SET uidvalidity = excluded.uidvalidity, last_uid = excluded.last_uid, modseq = excluded.modseq, last_sync_at = excluded.last_sync_at")
                .bind(&account.id).bind(&folder.raw_path).bind(status.uidvalidity as i64).bind(max_uid)
                .bind(status.highest_modseq.map(|v| v as i64))
                .execute(&mut *db).await.map_err(db_error)?;
        }
    }
    mark_sync(db, &account.id, Some("imap")).await?;
    Ok(changed)
}

fn folder_label(folder: &ImapFolder) -> (String, String, &'static str) {
    let name = folder.path.to_ascii_lowercase();
    let special = folder
        .special_use
        .as_deref()
        .unwrap_or("")
        .to_ascii_lowercase();
    let id = match special.as_str() {
        "\\sent" => Some("SENT"),
        "\\drafts" => Some("DRAFT"),
        "\\trash" => Some("TRASH"),
        "\\junk" => Some("SPAM"),
        "\\archive" => Some("archive"),
        "\\all" => Some("all-mail"),
        "\\flagged" => Some("STARRED"),
        "\\important" => Some("IMPORTANT"),
        _ => None,
    }
    .or_else(|| match name.as_str() {
        "inbox" => Some("INBOX"),
        "sent" | "sent items" | "sent mail" | "[gmail]/sent mail" => Some("SENT"),
        "draft" | "drafts" | "[gmail]/drafts" => Some("DRAFT"),
        "trash" | "deleted items" | "deleted messages" | "[gmail]/trash" => Some("TRASH"),
        "spam" | "junk" | "junk e-mail" | "[gmail]/spam" => Some("SPAM"),
        "archive" | "archives" => Some("archive"),
        "[gmail]/all mail" => Some("all-mail"),
        _ => None,
    });
    match id {
        Some(id) => (id.into(), folder.name.clone(), "system"),
        None => (
            format!("folder-{}", folder.path),
            folder.name.clone(),
            "user",
        ),
    }
}

async fn upsert_imap_label(
    db: &mut SqliteConnection,
    account: &str,
    folder: &ImapFolder,
) -> Result<(), String> {
    let (id, name, kind) = folder_label(folder);
    sqlx::query("INSERT INTO labels (id, account_id, name, type, imap_folder_path, imap_special_use) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(account_id, id) DO UPDATE SET name = excluded.name, type = excluded.type, imap_folder_path = excluded.imap_folder_path, imap_special_use = excluded.imap_special_use")
        .bind(&id).bind(account).bind(name).bind(kind).bind(&folder.raw_path).bind(&folder.special_use)
        .execute(&mut *db).await.map_err(db_error)?;
    Ok(())
}

async fn reconcile_imap_folder(
    db: &mut SqliteConnection,
    session: &mut async_imap::Session<crate::imap::client::ImapStream>,
    account: &str,
    folder: &ImapFolder,
    flags_changed: bool,
) -> Result<bool, String> {
    let remote_uids: HashSet<u32> = imap::search_all_uids(session, &folder.raw_path)
        .await?
        .into_iter()
        .collect();
    let stored = sqlx::query(
        "SELECT id, thread_id, imap_uid FROM messages WHERE account_id = ? AND imap_folder = ?",
    )
    .bind(account)
    .bind(&folder.raw_path)
    .fetch_all(&mut *db)
    .await
    .map_err(db_error)?;
    let mut affected = HashSet::new();
    let mut changed = false;
    for row in stored {
        let uid = row.get::<Option<i64>, _>("imap_uid").unwrap_or(0) as u32;
        if remote_uids.contains(&uid) {
            continue;
        }
        let thread: String = row.get("thread_id");
        if pending(db, account, &thread).await? {
            continue;
        }
        let id: String = row.get("id");
        sqlx::query("DELETE FROM messages WHERE account_id = ? AND id = ?")
            .bind(account)
            .bind(&id)
            .execute(&mut *db)
            .await
            .map_err(db_error)?;
        affected.insert(thread);
        changed = true;
    }
    if flags_changed {
        // UID FETCH FLAGS carries no bodies. MODSEQ lets conforming servers
        // avoid this pass when nothing changed; older servers need the scan.
        session
            .select(&folder.raw_path)
            .await
            .map_err(|e| format!("IMAP select for flags: {e}"))?;
        let fetches = tokio::time::timeout(Duration::from_secs(90), async {
            let stream = session
                .uid_fetch("1:*", "UID FLAGS")
                .await
                .map_err(|e| format!("IMAP flags fetch: {e}"))?;
            Ok::<_, String>(stream.collect::<Vec<_>>().await)
        })
        .await
        .map_err(|_| "IMAP flags fetch timed out".to_string())??;
        for result in fetches {
            let fetch = result.map_err(|e| format!("IMAP flags stream: {e}"))?;
            let Some(uid) = fetch.uid else {
                continue;
            };
            let flags: Vec<_> = fetch.flags().collect();
            let seen = flags
                .iter()
                .any(|f| matches!(f, async_imap::types::Flag::Seen));
            let starred = flags
                .iter()
                .any(|f| matches!(f, async_imap::types::Flag::Flagged));
            let row = sqlx::query("SELECT thread_id, is_read, is_starred FROM messages WHERE account_id = ? AND imap_folder = ? AND imap_uid = ?")
                .bind(account).bind(&folder.raw_path).bind(uid as i64).fetch_optional(&mut *db).await.map_err(db_error)?;
            let Some(row) = row else {
                continue;
            };
            let thread: String = row.get("thread_id");
            if pending(db, account, &thread).await? {
                continue;
            }
            if row.get::<i64, _>("is_read") != seen as i64
                || row.get::<i64, _>("is_starred") != starred as i64
            {
                sqlx::query("UPDATE messages SET is_read = ?, is_starred = ? WHERE account_id = ? AND imap_folder = ? AND imap_uid = ?")
                    .bind(seen as i64).bind(starred as i64).bind(account).bind(&folder.raw_path).bind(uid as i64)
                    .execute(&mut *db).await.map_err(db_error)?;
                affected.insert(thread);
                changed = true;
            }
        }
    }
    for thread in affected {
        recompute_imap_thread(db, account, &thread).await?;
    }
    Ok(changed)
}

async fn recompute_imap_thread(
    db: &mut SqliteConnection,
    account: &str,
    thread: &str,
) -> Result<(), String> {
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM messages WHERE account_id = ? AND thread_id = ?")
            .bind(account)
            .bind(thread)
            .fetch_one(&mut *db)
            .await
            .map_err(db_error)?;
    if count == 0 {
        sqlx::query("DELETE FROM threads WHERE account_id = ? AND id = ?")
            .bind(account)
            .bind(thread)
            .execute(&mut *db)
            .await
            .map_err(db_error)?;
        return Ok(());
    }
    sqlx::query("UPDATE threads SET message_count = ?, last_message_at = (SELECT MAX(date) FROM messages WHERE account_id = ? AND thread_id = ?), is_read = NOT EXISTS (SELECT 1 FROM messages WHERE account_id = ? AND thread_id = ? AND is_read = 0), is_starred = EXISTS (SELECT 1 FROM messages WHERE account_id = ? AND thread_id = ? AND is_starred = 1), has_attachments = EXISTS (SELECT 1 FROM attachments a JOIN messages m ON m.account_id = a.account_id AND m.id = a.message_id WHERE m.account_id = ? AND m.thread_id = ?) WHERE account_id = ? AND id = ?")
        .bind(count).bind(account).bind(thread).bind(account).bind(thread).bind(account).bind(thread)
        .bind(account).bind(thread).bind(account).bind(thread).execute(&mut *db).await.map_err(db_error)?;
    sqlx::query("DELETE FROM thread_labels WHERE account_id = ? AND thread_id = ? AND (label_id IN ('UNREAD', 'STARRED') OR label_id IN (SELECT id FROM labels WHERE account_id = ? AND imap_folder_path IS NOT NULL))")
        .bind(account).bind(thread).bind(account).execute(&mut *db).await.map_err(db_error)?;
    let labels: Vec<String> = sqlx::query_scalar("SELECT DISTINCT l.id FROM messages m JOIN labels l ON l.account_id = m.account_id AND l.imap_folder_path = m.imap_folder WHERE m.account_id = ? AND m.thread_id = ?")
        .bind(account).bind(thread).fetch_all(&mut *db).await.map_err(db_error)?;
    for label in labels {
        sqlx::query("INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id) VALUES (?, ?, ?)")
            .bind(account).bind(thread).bind(label).execute(&mut *db).await.map_err(db_error)?;
    }
    let unread: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM messages WHERE account_id = ? AND thread_id = ? AND is_read = 0",
    )
    .bind(account)
    .bind(thread)
    .fetch_one(&mut *db)
    .await
    .map_err(db_error)?;
    let starred: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM messages WHERE account_id = ? AND thread_id = ? AND is_starred = 1",
    )
    .bind(account)
    .bind(thread)
    .fetch_one(&mut *db)
    .await
    .map_err(db_error)?;
    for (label, present) in [("UNREAD", unread > 0), ("STARRED", starred > 0)] {
        if present {
            sqlx::query("INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id) VALUES (?, ?, ?)")
                .bind(account).bind(thread).bind(label).execute(&mut *db).await.map_err(db_error)?;
        }
    }
    Ok(())
}

fn parse_references(value: Option<&str>) -> Vec<String> {
    let Some(value) = value else { return Vec::new(); };
    let mut ids = Vec::new();
    let mut rest = value;
    while let Some(start) = rest.find('<') {
        rest = &rest[start + 1..];
        let Some(end) = rest.find('>') else { break; };
        let id = rest[..end].trim();
        if !id.is_empty() { ids.push(id.to_owned()); }
        rest = &rest[end + 1..];
    }
    if ids.is_empty() {
        ids.extend(value.split_whitespace().map(|token| token.trim_matches(&['<', '>'][..]).to_owned()).filter(|id| !id.is_empty()));
    }
    ids
}

fn references_for(message: &ImapMessage) -> Vec<String> {
    let mut ids = parse_references(message.references.as_deref());
    for id in parse_references(message.in_reply_to.as_deref()) {
        if !ids.contains(&id) { ids.push(id); }
    }
    ids
}

fn imap_hash(value: &str) -> String {
    let mut hash: u32 = 5381;
    for code in value.encode_utf16() {
        hash = hash.wrapping_mul(33).wrapping_add(code as u32);
    }
    format!("{hash:x}")
}

async fn imap_thread_id(
    db: &mut SqliteConnection,
    account: &str,
    message: &ImapMessage,
) -> Result<String, String> {
    // Replaying a stable folder UID must never create a second, empty thread
    // when later headers reveal a different root.
    let stable_id = format!("imap-{account}-{}-{}", message.folder, message.uid);
    let existing: Option<String> = sqlx::query_scalar("SELECT thread_id FROM messages WHERE account_id = ? AND id = ?")
        .bind(account).bind(&stable_id).fetch_optional(&mut *db).await.map_err(db_error)?;
    if let Some(id) = existing { return Ok(id); }
    let references = references_for(message);
    for reference in references.iter().rev() {
        let existing: Option<String> = sqlx::query_scalar("SELECT thread_id FROM messages WHERE account_id = ? AND trim(trim(message_id_header), '<>') = ? LIMIT 1")
            .bind(account).bind(reference).fetch_optional(&mut *db).await.map_err(db_error)?;
        if let Some(id) = existing { return Ok(id); }
    }
    // A missing parent may arrive later than its child. Follow the child's
    // exact parsed headers to retain the established local thread ID.
    if let Some(message_id) = parse_references(message.message_id.as_deref()).first() {
        let candidates = sqlx::query("SELECT thread_id, references_header, in_reply_to_header FROM messages WHERE account_id = ? AND (references_header LIKE ? OR in_reply_to_header LIKE ?)")
            .bind(account).bind(format!("%{message_id}%")).bind(format!("%{message_id}%"))
            .fetch_all(&mut *db).await.map_err(db_error)?;
        for row in candidates {
            let references = parse_references(row.get::<Option<String>, _>("references_header").as_deref());
            let replies = parse_references(row.get::<Option<String>, _>("in_reply_to_header").as_deref());
            if references.iter().chain(replies.iter()).any(|candidate| candidate == message_id) {
                return Ok(row.get("thread_id"));
            }
        }
    }
    let root = references.first().cloned().or_else(|| parse_references(message.message_id.as_deref()).first().cloned())
        .unwrap_or_else(|| {
            format!(
                "synthetic-{account}-{}-{}@sndmail.local",
                message.folder, message.uid
            )
        });
    Ok(format!("imap-thread-{}", imap_hash(&root)))
}

async fn store_imap_message(
    db: &mut SqliteConnection,
    account: &str,
    folder: &ImapFolder,
    thread: &str,
    msg: &ImapMessage,
    in_transaction: bool,
) -> Result<(), String> {
    let message_id = format!("imap-{account}-{}-{}", msg.folder, msg.uid);
    let (label, _, _) = folder_label(folder);
    if !in_transaction {
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut *db)
            .await
            .map_err(db_error)?;
    }
    let result = async {
        sqlx::query("INSERT OR IGNORE INTO threads (id, account_id, subject, snippet, last_message_at, message_count, is_read, is_starred, has_attachments) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)")
            .bind(thread).bind(account).bind(&msg.subject).bind(&msg.snippet).bind(msg.date * 1000)
            .bind(msg.is_read as i64).bind(msg.is_starred as i64).bind((!msg.attachments.is_empty()) as i64)
            .execute(&mut *db).await.map_err(db_error)?;
        sqlx::query("INSERT INTO messages (id, account_id, thread_id, from_address, from_name, to_addresses, cc_addresses, bcc_addresses, reply_to, subject, snippet, date, is_read, is_starred, body_html, body_text, body_cached, raw_size, internal_date, list_unsubscribe, list_unsubscribe_post, auth_results, message_id_header, references_header, in_reply_to_header, imap_uid, imap_folder, disposition_notification_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(account_id, id) DO UPDATE SET from_address = excluded.from_address, from_name = excluded.from_name, to_addresses = excluded.to_addresses, cc_addresses = excluded.cc_addresses, bcc_addresses = excluded.bcc_addresses, reply_to = excluded.reply_to, subject = excluded.subject, snippet = excluded.snippet, date = excluded.date, is_read = excluded.is_read, is_starred = excluded.is_starred, body_html = COALESCE(excluded.body_html, messages.body_html), body_text = COALESCE(excluded.body_text, messages.body_text), body_cached = MAX(messages.body_cached, excluded.body_cached), raw_size = excluded.raw_size, internal_date = excluded.internal_date, list_unsubscribe = excluded.list_unsubscribe, list_unsubscribe_post = excluded.list_unsubscribe_post, auth_results = excluded.auth_results, message_id_header = COALESCE(excluded.message_id_header, messages.message_id_header), references_header = COALESCE(excluded.references_header, messages.references_header), in_reply_to_header = COALESCE(excluded.in_reply_to_header, messages.in_reply_to_header), imap_uid = excluded.imap_uid, imap_folder = excluded.imap_folder, disposition_notification_to = COALESCE(excluded.disposition_notification_to, messages.disposition_notification_to)")
            .bind(&message_id).bind(account).bind(thread).bind(&msg.from_address).bind(&msg.from_name)
            .bind(&msg.to_addresses).bind(&msg.cc_addresses).bind(&msg.bcc_addresses).bind(&msg.reply_to)
            .bind(&msg.subject).bind(&msg.snippet).bind(msg.date * 1000).bind(msg.is_read as i64).bind(msg.is_starred as i64)
            .bind(&msg.body_html).bind(&msg.body_text).bind((msg.body_html.is_some() || msg.body_text.is_some()) as i64)
            .bind(msg.raw_size as i64).bind(msg.date * 1000).bind(&msg.list_unsubscribe).bind(&msg.list_unsubscribe_post)
            .bind(&msg.auth_results).bind(&msg.message_id).bind(&msg.references).bind(&msg.in_reply_to)
            .bind(msg.uid as i64).bind(&msg.folder).bind(&msg.disposition_notification_to)
            .execute(&mut *db).await.map_err(db_error)?;
        sqlx::query("INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id) VALUES (?, ?, ?)")
            .bind(account).bind(thread).bind(&label).execute(&mut *db).await.map_err(db_error)?;
        for extra in [(!msg.is_read).then_some("UNREAD"), msg.is_starred.then_some("STARRED"), msg.is_draft.then_some("DRAFT")].into_iter().flatten() {
            sqlx::query("INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id) VALUES (?, ?, ?)")
                .bind(account).bind(thread).bind(extra).execute(&mut *db).await.map_err(db_error)?;
        }
        for att in &msg.attachments {
            sqlx::query("INSERT INTO attachments (id, message_id, account_id, filename, mime_type, size, imap_part_id, content_id, is_inline) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET filename = excluded.filename, mime_type = excluded.mime_type, size = excluded.size")
                .bind(format!("{message_id}_{}", att.part_id)).bind(&message_id).bind(account)
                .bind(&att.filename).bind(&att.mime_type).bind(att.size as i64).bind(&att.part_id)
                .bind(&att.content_id).bind(att.is_inline as i64).execute(&mut *db).await.map_err(db_error)?;
        }
        sqlx::query("UPDATE threads SET message_count = (SELECT COUNT(*) FROM messages WHERE account_id = ? AND thread_id = ?), last_message_at = MAX(COALESCE(last_message_at, 0), ?), is_read = NOT EXISTS (SELECT 1 FROM messages WHERE account_id = ? AND thread_id = ? AND is_read = 0), is_starred = EXISTS (SELECT 1 FROM messages WHERE account_id = ? AND thread_id = ? AND is_starred = 1), has_attachments = EXISTS (SELECT 1 FROM attachments a JOIN messages m ON m.account_id = a.account_id AND m.id = a.message_id WHERE m.account_id = ? AND m.thread_id = ?) WHERE account_id = ? AND id = ?")
            .bind(account).bind(thread).bind(msg.date * 1000).bind(account).bind(thread).bind(account).bind(thread)
            .bind(account).bind(thread).bind(account).bind(thread).execute(&mut *db).await.map_err(db_error)?;
        Ok::<(), String>(())
    }.await;
    match result {
        Ok(()) if in_transaction => Ok(()),
        Ok(()) => sqlx::query("COMMIT")
            .execute(&mut *db)
            .await
            .map(|_| ())
            .map_err(db_error),
        Err(error) => {
            if !in_transaction { let _ = sqlx::query("ROLLBACK").execute(&mut *db).await; }
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{decode_gmail_body, decrypt, encrypt, error_category, find_gmail_body_part, gmail_retry_delay, is_gmail_rate_reason, oauth_refresh_error};
    use base64::Engine;

    #[test]
    fn oauth_failures_keep_only_allowlisted_codes_and_http_status() {
        let rejected = serde_json::json!({
            "error": "invalid_grant",
            "error_description": "private account and token details"
        });
        let known = oauth_refresh_error("Gmail", reqwest::StatusCode::BAD_REQUEST, Some(&rejected));
        assert_eq!(known, "Gmail OAuth invalid_grant");
        assert_eq!(error_category(&known), "provider OAuth invalid_grant");

        let unknown = serde_json::json!({
            "error": "private account and token details",
            "error_description": "even more private details"
        });
        let safe = oauth_refresh_error("Gmail", reqwest::StatusCode::BAD_REQUEST, Some(&unknown));
        assert_eq!(safe, "Gmail token refresh returned HTTP 400");
        assert_eq!(error_category(&safe), "provider HTTP 400");
        assert_eq!(error_category("Gmail returned HTTP 403 Forbidden"), "provider HTTP 403");
        assert_eq!(error_category("Gmail request failed: network timeout"), "provider network unavailable");
        assert_eq!(error_category("Gmail rate limited"), "Gmail API rate limited");
    }

    #[test]
    fn gmail_retry_backoff_is_bounded_and_honors_retry_after() {
        assert_eq!(gmail_retry_delay(0, None, 0), std::time::Duration::from_secs(1));
        assert_eq!(gmail_retry_delay(2, None, 250), std::time::Duration::from_millis(4_250));
        assert_eq!(gmail_retry_delay(0, Some(10), 0), std::time::Duration::from_secs(10));
        assert_eq!(gmail_retry_delay(5, Some(3_600), 999), std::time::Duration::from_secs(32));
        assert!(is_gmail_rate_reason(&serde_json::json!({"error": {"errors": [{"reason": "rateLimitExceeded"}]}})));
        assert!(is_gmail_rate_reason(&serde_json::json!({"error": {"errors": [{"reason": "userRateLimitExceeded"}]}})));
        assert!(!is_gmail_rate_reason(&serde_json::json!({"error": {"errors": [{"reason": "insufficientPermissions"}], "message": "private details"}})));
    }

    #[test]
    fn body_lookup_selects_inline_and_attachment_backed_body_parts_only() {
        let message = serde_json::json!({
            "mimeType": "multipart/mixed",
            "parts": [
                {"mimeType": "application/pdf", "filename": "invoice.pdf", "body": {"attachmentId": "file-1"}},
                {"mimeType": "multipart/alternative", "parts": [
                    {"mimeType": "text/plain", "filename": "notes.txt", "body": {"attachmentId": "file-2"}},
                    {"mimeType": "text/plain", "body": {"data": "SGVsbG8"}},
                    {"mimeType": "text/html", "body": {"attachmentId": "body-1", "size": 90000}}
                ]}
            ]
        });

        let plain = find_gmail_body_part(&message, "text/plain").unwrap();
        assert_eq!(decode_gmail_body(plain["body"]["data"].as_str().unwrap()).as_deref(), Some("Hello"));
        let html = find_gmail_body_part(&message, "text/html").unwrap();
        assert_eq!(html["body"]["attachmentId"], "body-1");
        assert!(find_gmail_body_part(&message, "application/octet-stream").is_none());
        let attached_text_only = serde_json::json!({
            "mimeType": "multipart/mixed",
            "parts": [{
                "mimeType": "text/plain",
                "filename": "notes.txt",
                "headers": [{"name": "Content-Disposition", "value": "attachment; filename=notes.txt"}],
                "body": {"attachmentId": "file-2"}
            }]
        });
        assert!(find_gmail_body_part(&attached_text_only, "text/plain").is_none());
    }

    #[test]
    fn frontend_aes_gcm_credential_format_roundtrips_and_rejects_wrong_key() {
        // Same lock the worker-profiles fixture tests take: these env vars
        // are process-global and parallel tests would delete each other's dir.
        let _guard = crate::worker::profiles::FIXTURE_ENV_LOCK
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let dir = std::env::temp_dir().join(format!("sndmail-worker-crypto-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let old_fixture = std::env::var_os("SNDMAIL_WORKER_FIXTURE");
        let old_data = std::env::var_os("SNDMAIL_WORKER_DATA_DIR");
        std::env::set_var("SNDMAIL_WORKER_FIXTURE", "1");
        std::env::set_var("SNDMAIL_WORKER_DATA_DIR", &dir);
        let key = [23_u8; 32];
        std::fs::write(dir.join("sndmail.key"), base64::engine::general_purpose::STANDARD.encode(key)).unwrap();
        let encoded = encrypt("refresh-token-μ").unwrap();
        let (iv, body) = encoded.split_once(':').unwrap();
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(iv).unwrap().len(), 12);
        assert!(base64::engine::general_purpose::STANDARD.decode(body).unwrap().len() > 16);
        assert_eq!(decrypt(&encoded).unwrap(), "refresh-token-μ");
        std::fs::write(dir.join("sndmail.key"), base64::engine::general_purpose::STANDARD.encode([42_u8; 32])).unwrap();
        assert!(decrypt(&encoded).is_err());
        let _ = std::fs::remove_dir_all(dir);
        if let Some(value) = old_fixture { std::env::set_var("SNDMAIL_WORKER_FIXTURE", value); }
        else { std::env::remove_var("SNDMAIL_WORKER_FIXTURE"); }
        if let Some(value) = old_data { std::env::set_var("SNDMAIL_WORKER_DATA_DIR", value); }
        else { std::env::remove_var("SNDMAIL_WORKER_DATA_DIR"); }
    }
}
