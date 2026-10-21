//! Account setup over IPC.
//!
//! Adding a mail account writes the mailbox, its IMAP/SMTP server settings and
//! its credentials into the canonical `sndmail.db` that the background worker
//! reads. Doing that from the frontend meant two writers with two ideas of the
//! credential format, and it let a half-validated account reach the database
//! that the worker then tries to log in with. Account creation now arrives here
//! as one validated request: the secrets are encrypted with the same key and
//! format `src/utils/crypto.ts` uses, and nothing is written unless every field
//! checks out.

use std::path::Path;
use std::time::Duration;

use serde::Deserialize;
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{Connection, SqliteConnection};

use crate::credentials::encrypt;

/// The security modes the account form stores. The UI shows "SSL/TLS",
/// "STARTTLS" and "None"; the database keeps these identifiers.
const SECURITY_MODES: [&str; 3] = ["ssl", "starttls", "none"];
const AUTH_METHODS: [&str; 2] = ["password", "oauth2"];

/// One IMAP/SMTP mailbox as submitted by the account form.
///
/// Field names are snake_case to match the other IMAP commands the form already
/// calls (`imap_test_connection`, `smtp_test_connection`).
#[derive(Debug, Clone, Deserialize)]
pub struct ImapAccountSetup {
    pub id: String,
    pub email: String,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub avatar_url: Option<String>,
    pub imap_host: String,
    pub imap_port: u16,
    pub imap_security: String,
    pub smtp_host: String,
    pub smtp_port: u16,
    pub smtp_security: String,
    /// "password" or "oauth2".
    pub auth_method: String,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub access_token: Option<String>,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub token_expires_at: Option<i64>,
    #[serde(default)]
    pub oauth_provider: Option<String>,
    #[serde(default)]
    pub oauth_client_id: Option<String>,
    #[serde(default)]
    pub oauth_client_secret: Option<String>,
    #[serde(default)]
    pub imap_username: Option<String>,
    #[serde(default)]
    pub accept_invalid_certs: bool,
}

fn trimmed(value: &str) -> &str {
    value.trim()
}

fn require_text(value: &str, what: &str) -> Result<String, String> {
    let value = trimmed(value);
    if value.is_empty() {
        return Err(format!("{what} is required"));
    }
    Ok(value.to_string())
}

fn optional_text(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn require_email(value: &str) -> Result<String, String> {
    let email = require_text(value, "Email address")?;
    let mut parts = email.split('@');
    let (Some(local), Some(domain), None) = (parts.next(), parts.next(), parts.next()) else {
        return Err("Email address must contain exactly one @".to_string());
    };
    if local.is_empty() || domain.is_empty() || !domain.contains('.') {
        return Err("Email address is not valid".to_string());
    }
    if email.chars().any(|c| c.is_whitespace()) {
        return Err("Email address must not contain spaces".to_string());
    }
    Ok(email)
}

fn require_host(value: &str, what: &str) -> Result<String, String> {
    let host = require_text(value, what)?;
    if host.chars().any(|c| c.is_whitespace()) || host.contains("://") || host.contains('/') {
        return Err(format!("{what} must be a hostname without a scheme or path"));
    }
    Ok(host)
}

fn require_port(port: u16, what: &str) -> Result<u16, String> {
    if port == 0 {
        return Err(format!("{what} must be between 1 and 65535"));
    }
    Ok(port)
}

fn require_security(value: &str, what: &str) -> Result<String, String> {
    let value = trimmed(value).to_ascii_lowercase();
    if !SECURITY_MODES.contains(&value.as_str()) {
        return Err(format!("{what} must be one of ssl, starttls or none"));
    }
    Ok(value)
}

/// Check the whole request before anything is stored.
///
/// Kept separate from the database write so the rules can be tested directly.
pub fn validate_candidate(account: ImapAccountSetup) -> Result<ImapAccountSetup, String> {
    let id = require_text(&account.id, "Account id")?;
    if id.len() > 128 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("Account id must be 1-128 characters of letters, digits, - or _".to_string());
    }
    let email = require_email(&account.email)?;
    let imap_host = require_host(&account.imap_host, "IMAP server")?;
    let smtp_host = require_host(&account.smtp_host, "SMTP server")?;
    let imap_port = require_port(account.imap_port, "IMAP port")?;
    let smtp_port = require_port(account.smtp_port, "SMTP port")?;
    let imap_security = require_security(&account.imap_security, "IMAP security")?;
    let smtp_security = require_security(&account.smtp_security, "SMTP security")?;
    let auth_method = trimmed(&account.auth_method).to_ascii_lowercase();
    if !AUTH_METHODS.contains(&auth_method.as_str()) {
        return Err("Authentication must be password or oauth2".to_string());
    }

    let (password, access_token, refresh_token, token_expires_at, oauth_provider, oauth_client_id) =
        if auth_method == "password" {
            let password = require_text(account.password.as_deref().unwrap_or_default(), "Password")?;
            (Some(password), None, None, None, None, None)
        } else {
            let access_token =
                require_text(account.access_token.as_deref().unwrap_or_default(), "Access token")?;
            let refresh_token = require_text(
                account.refresh_token.as_deref().unwrap_or_default(),
                "Refresh token",
            )?;
            let oauth_provider =
                require_text(account.oauth_provider.as_deref().unwrap_or_default(), "OAuth provider")?;
            let oauth_client_id = require_text(
                account.oauth_client_id.as_deref().unwrap_or_default(),
                "OAuth client id",
            )?;
            let token_expires_at = account
                .token_expires_at
                .filter(|expires| *expires > 0)
                .ok_or("Access token expiry is required for OAuth accounts")?;
            (
                None,
                Some(access_token),
                Some(refresh_token),
                Some(token_expires_at),
                Some(oauth_provider),
                Some(oauth_client_id),
            )
        };

    Ok(ImapAccountSetup {
        id,
        email,
        display_name: optional_text(account.display_name),
        avatar_url: optional_text(account.avatar_url),
        imap_host,
        imap_port,
        imap_security,
        smtp_host,
        smtp_port,
        smtp_security,
        auth_method,
        password,
        access_token,
        refresh_token,
        token_expires_at,
        oauth_provider,
        oauth_client_id,
        oauth_client_secret: optional_text(account.oauth_client_secret),
        imap_username: optional_text(account.imap_username),
        accept_invalid_certs: account.accept_invalid_certs,
    })
}

/// Escape hatch for tests that need the row without a real credential store.
fn encrypted(value: Option<&str>) -> Result<Option<String>, String> {
    match value {
        Some(value) => encrypt(value).map(Some),
        None => Ok(None),
    }
}

/// Insert a validated mailbox into the mail store at `database`.
///
/// The database must already exist: the frontend owns schema migration, and the
/// worker leaves an uninitialized database alone until the app has opened it.
pub async fn insert_imap_account(
    database: &Path,
    account: ImapAccountSetup,
) -> Result<(), String> {
    let account = validate_candidate(account)?;
    if !database.is_file() {
        return Err("The mail database has not been initialized yet. Restart sndmail and try again.".to_string());
    }
    let options = SqliteConnectOptions::new()
        .filename(database)
        .create_if_missing(false)
        .busy_timeout(Duration::from_secs(5));
    let mut db = SqliteConnection::connect_with(&options)
        .await
        .map_err(|error| format!("open mail database: {error}"))?;

    let table: Option<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'accounts'",
    )
    .fetch_optional(&mut db)
    .await
    .map_err(|error| format!("read mail database schema: {error}"))?;
    if table.is_none() {
        return Err("The mail database is not initialized yet. Restart sndmail and try again.".to_string());
    }

    let password = encrypted(account.password.as_deref())?;
    let access_token = encrypted(account.access_token.as_deref())?;
    let refresh_token = encrypted(account.refresh_token.as_deref())?;
    let client_secret = encrypted(account.oauth_client_secret.as_deref())?;

    sqlx::query(
        "INSERT INTO accounts (id, email, display_name, avatar_url, access_token, refresh_token, token_expires_at, provider, imap_host, imap_port, imap_security, smtp_host, smtp_port, smtp_security, auth_method, imap_password, imap_username, accept_invalid_certs, oauth_provider, oauth_client_id, oauth_client_secret)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'imap', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&account.id)
    .bind(&account.email)
    .bind(&account.display_name)
    .bind(&account.avatar_url)
    .bind(&access_token)
    .bind(&refresh_token)
    .bind(account.token_expires_at)
    .bind(&account.imap_host)
    .bind(i64::from(account.imap_port))
    .bind(&account.imap_security)
    .bind(&account.smtp_host)
    .bind(i64::from(account.smtp_port))
    .bind(&account.smtp_security)
    .bind(&account.auth_method)
    .bind(&password)
    .bind(&account.imap_username)
    .bind(i64::from(account.accept_invalid_certs))
    .bind(&account.oauth_provider)
    .bind(&account.oauth_client_id)
    .bind(&client_secret)
    .execute(&mut db)
    .await
    .map_err(|error| {
        let message = error.to_string();
        if message.contains("UNIQUE") {
            return format!("{} is already connected", account.email);
        }
        format!("store the mail account: {message}")
    })?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::FIXTURE_ENV_LOCK;
    use base64::Engine;

    fn candidate() -> ImapAccountSetup {
        ImapAccountSetup {
            id: "acc-1".into(),
            email: "user@fastmail.com".into(),
            display_name: Some(" Fastmail User ".into()),
            avatar_url: None,
            imap_host: "imap.fastmail.com".into(),
            imap_port: 993,
            imap_security: "ssl".into(),
            smtp_host: "smtp.fastmail.com".into(),
            smtp_port: 465,
            smtp_security: "ssl".into(),
            auth_method: "password".into(),
            password: Some("app-password".into()),
            access_token: None,
            refresh_token: None,
            token_expires_at: None,
            oauth_provider: None,
            oauth_client_id: None,
            oauth_client_secret: None,
            imap_username: Some("  ".into()),
            accept_invalid_certs: false,
        }
    }

    #[test]
    fn accepts_a_normal_mailbox_and_normalizes_blank_optional_fields() {
        let account = validate_candidate(candidate()).expect("valid mailbox");
        assert_eq!(account.display_name.as_deref(), Some("Fastmail User"));
        assert_eq!(account.imap_username, None);
        assert_eq!(account.imap_security, "ssl");
        assert_eq!(account.auth_method, "password");
    }

    #[test]
    fn rejects_requests_the_worker_could_not_use() {
        let cases: Vec<(&str, Box<dyn Fn(&mut ImapAccountSetup)>)> = vec![
            ("blank id", Box::new(|a| a.id = " ".into())),
            ("id with separator", Box::new(|a| a.id = "a/b".into())),
            ("two @", Box::new(|a| a.email = "a@b@c.d".into())),
            ("no domain dot", Box::new(|a| a.email = "user@localhost".into())),
            ("imap host with scheme", Box::new(|a| a.imap_host = "imaps://imap.x.com".into())),
            ("zero smtp port", Box::new(|a| a.smtp_port = 0)),
            ("unknown security", Box::new(|a| a.imap_security = "tls".into())),
            ("unknown auth", Box::new(|a| a.auth_method = "kerberos".into())),
            ("missing password", Box::new(|a| a.password = Some("  ".into()))),
        ];
        for (name, mutate) in cases {
            let mut account = candidate();
            mutate(&mut account);
            assert!(validate_candidate(account).is_err(), "{name} should be rejected");
        }
    }

    #[test]
    fn oauth_accounts_need_tokens_and_an_expiry() {
        let mut account = candidate();
        account.auth_method = "oauth2".into();
        account.password = None;
        assert!(validate_candidate(account.clone()).is_err());

        account.access_token = Some("access".into());
        account.refresh_token = Some("refresh".into());
        account.oauth_provider = Some("google".into());
        account.oauth_client_id = Some("client".into());
        account.token_expires_at = Some(0);
        assert!(validate_candidate(account.clone()).is_err());

        account.token_expires_at = Some(1_700_000_000);
        let valid = validate_candidate(account).expect("valid oauth mailbox");
        assert_eq!(valid.auth_method, "oauth2");
        assert!(valid.password.is_none());
    }

    #[tokio::test]
    async fn writes_an_account_whose_password_decrypts_with_the_shared_key() {
        let _guard = FIXTURE_ENV_LOCK.lock().unwrap_or_else(|poison| poison.into_inner());
        let directory = std::env::temp_dir().join(format!(
            "sndmail-account-setup-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).unwrap();
        let old_fixture = std::env::var_os("SNDMAIL_WORKER_FIXTURE");
        let old_data = std::env::var_os("SNDMAIL_WORKER_DATA_DIR");
        std::env::set_var("SNDMAIL_WORKER_FIXTURE", "1");
        std::env::set_var("SNDMAIL_WORKER_DATA_DIR", &directory);
        let key = base64::engine::general_purpose::STANDARD.encode([7_u8; 32]);
        std::fs::write(directory.join("sndmail.key"), key).unwrap();

        let database = directory.join("sndmail.db");
        {
            let options = SqliteConnectOptions::new()
                .filename(&database)
                .create_if_missing(true);
            let mut db = SqliteConnection::connect_with(&options).await.unwrap();
            sqlx::query(
                "CREATE TABLE accounts (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, display_name TEXT, avatar_url TEXT, access_token TEXT, refresh_token TEXT, token_expires_at INTEGER, history_id TEXT, last_sync_at INTEGER, is_active INTEGER DEFAULT 1, created_at INTEGER DEFAULT (unixepoch()), updated_at INTEGER DEFAULT (unixepoch()), provider TEXT, imap_host TEXT, imap_port INTEGER, imap_security TEXT, smtp_host TEXT, smtp_port INTEGER, smtp_security TEXT, auth_method TEXT, imap_password TEXT, imap_username TEXT, accept_invalid_certs INTEGER, oauth_provider TEXT, oauth_client_id TEXT, oauth_client_secret TEXT)",
            )
            .execute(&mut db)
            .await
            .unwrap();
        }

        insert_imap_account(&database, candidate()).await.expect("account is stored");

        let options = SqliteConnectOptions::new().filename(&database);
        let mut db = SqliteConnection::connect_with(&options).await.unwrap();
        let row: (String, String, Option<String>, Option<String>, Option<String>) = sqlx::query_as(
            "SELECT email, provider, imap_password, oauth_provider, imap_username FROM accounts WHERE id = ?",
        )
        .bind("acc-1")
        .fetch_one(&mut db)
        .await
        .unwrap();
        assert_eq!(row.0, "user@fastmail.com");
        assert_eq!(row.1, "imap");
        assert!(row.3.is_none() && row.4.is_none());
        let stored = row.2.expect("password stored");
        assert_ne!(stored, "app-password", "the password must not be stored in the clear");
        assert_eq!(
            crate::credentials::decrypt(&stored).unwrap(),
            "app-password",
            "the worker must be able to read what the app wrote"
        );

        // The same address cannot be connected twice.
        let duplicate = insert_imap_account(&database, candidate()).await;
        assert!(duplicate.unwrap_err().contains("already connected"));

        drop(db);
        let _ = std::fs::remove_dir_all(&directory);
        match old_fixture {
            Some(value) => std::env::set_var("SNDMAIL_WORKER_FIXTURE", value),
            None => std::env::remove_var("SNDMAIL_WORKER_FIXTURE"),
        }
        match old_data {
            Some(value) => std::env::set_var("SNDMAIL_WORKER_DATA_DIR", value),
            None => std::env::remove_var("SNDMAIL_WORKER_DATA_DIR"),
        }
    }
}
