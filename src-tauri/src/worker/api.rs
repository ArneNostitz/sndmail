//! Read-only, same-user IPC for Commonplace. Data operations require an
//! explicit profile capability; metadata responses never include bodies,
//! snippets, credentials, or one-time codes.

use std::io;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::sqlite::SqliteRow;
use sqlx::{Connection, Row, SqliteConnection};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{broadcast, Semaphore};
use tokio_util::sync::CancellationToken;

use super::lifecycle::WorkerContext;
use super::profiles::{load_profiles, Profile};

const MAX_REQUEST_BYTES: usize = 16 * 1024;
const MAX_RESPONSE_BYTES: usize = 256 * 1024;
const MAX_PAGE_SIZE: i64 = 100;
const MAX_CONNECTIONS: usize = 32;
const IO_TIMEOUT: Duration = Duration::from_secs(10);
const MIN_SCHEMA_VERSION: i64 = 32;
const MAX_CONTENT_CHARS: i64 = 8 * 1024;
const MAX_SEARCH_QUERY_CHARS: usize = 256;

trait ApiContext: Clone + Send + Sync + 'static {
    fn mail_ready(&self) -> bool;
    fn notify_mail_changed(&self, account_id: String);
    fn notify_relay_changed(&self);
    fn subscribe_mail_changes(&self) -> broadcast::Receiver<String>;
    fn shutdown_token(&self) -> CancellationToken;
    fn revalidation_interval(&self) -> Duration {
        Duration::from_secs(15)
    }
    fn profile(&self, profile_id: &str, token: &str) -> Result<Profile, String>;
}

impl ApiContext for WorkerContext {
    fn mail_ready(&self) -> bool {
        WorkerContext::mail_ready(self)
    }
    fn notify_mail_changed(&self, account_id: String) {
        WorkerContext::notify_mail_changed(self, account_id)
    }
    fn notify_relay_changed(&self) {
        WorkerContext::notify_relay_changed(self)
    }
    fn subscribe_mail_changes(&self) -> broadcast::Receiver<String> {
        WorkerContext::subscribe_mail_changes(self)
    }
    fn shutdown_token(&self) -> CancellationToken {
        WorkerContext::shutdown(self)
    }
    fn profile(&self, profile_id: &str, token: &str) -> Result<Profile, String> {
        let profile = load_profiles()?
            .into_iter()
            .find(|profile| profile.profile_id == profile_id)
            .ok_or("invalid profile capability")?;
        if !profile.verify_token(token) {
            return Err("invalid profile capability".into());
        }
        Ok(profile)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    op: String,
    #[serde(default)]
    profile_id: Option<String>,
    #[serde(default)]
    token: Option<String>,
    #[serde(default)]
    account_id: Option<String>,
    #[serde(default)]
    message_id: Option<String>,
    #[serde(default)]
    cursor: Option<Cursor>,
    #[serde(default)]
    limit: Option<i64>,
    #[serde(default)]
    query: Option<String>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Cursor {
    Message(MessageCursor),
    Journal(JournalCursor),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MessageCursor {
    date: i64,
    id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct JournalCursor {
    seq: i64,
}

#[derive(serde::Serialize)]
struct Envelope {
    ok: bool,
    data: Value,
}

pub(crate) fn bind(path: &Path) -> Result<UnixListener, String> {
    if let Ok(metadata) = std::fs::symlink_metadata(path) {
        use std::os::unix::fs::FileTypeExt;
        if !metadata.file_type().is_socket() {
            return Err("worker socket path exists and is not a socket".into());
        }
        std::fs::remove_file(path)
            .map_err(|error| format!("remove stale worker socket: {error}"))?;
    }
    let listener =
        UnixListener::bind(path).map_err(|error| format!("bind worker socket: {error}"))?;
    use std::os::unix::fs::PermissionsExt;
    if let Err(error) = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)) {
        let _ = std::fs::remove_file(path);
        return Err(format!("restrict worker socket: {error}"));
    }
    Ok(listener)
}

pub(crate) async fn run(listener: UnixListener, context: WorkerContext) -> Result<(), String> {
    let database = context.data_dir()?.join("sndmail.db");
    let socket_path = context.socket_path()?;
    let permits = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    let shutdown = context.shutdown_token();
    loop {
        tokio::select! {
            _ = shutdown.cancelled() => break,
            accepted = listener.accept() => {
                let (stream, _) = accepted.map_err(|error| format!("accept worker client: {error}"))?;
                let Ok(permit) = permits.clone().try_acquire_owned() else {
                    drop(stream);
                    continue;
                };
                let database = database.clone();
                let context = context.clone();
                tokio::spawn(async move {
                    let _permit = permit;
                    if let Err(error) = serve_client(stream, &database, &context).await {
                        log::debug!("worker client request closed: {error}");
                    }
                });
            }
        }
    }
    drop(listener);
    let _ = std::fs::remove_file(socket_path);
    Ok(())
}

async fn serve_client<C: ApiContext>(
    stream: UnixStream,
    database: &Path,
    context: &C,
) -> Result<(), String> {
    if !same_user(&stream)? {
        return Err("worker socket client has a different user ID".into());
    }
    let (read, mut write) = stream.into_split();
    let mut reader = BufReader::with_capacity(4096, read);
    loop {
        let line = tokio::time::timeout(IO_TIMEOUT, read_bounded_line(&mut reader))
            .await
            .map_err(|_| "worker request timed out".to_string())?
            .map_err(|error| error.to_string())?;
        let Some(line) = line else { return Ok(()) };
        let request = match serde_json::from_slice::<Request>(&line) {
            Ok(request) => request,
            Err(_) => {
                write_envelope(&mut write, false, json!({"error":"invalid request"})).await?;
                continue;
            }
        };
        if request.op == "subscribe" {
            return serve_subscription(&mut reader, &mut write, database, context, request).await;
        }
        let result = tokio::time::timeout(IO_TIMEOUT, dispatch(database, context, request))
            .await
            .map_err(|_| "worker operation timed out".to_string())?;
        match result {
            Ok(data) => write_envelope(&mut write, true, data).await?,
            Err(error) => write_envelope(&mut write, false, json!({"error":error})).await?,
        }
    }
}

/// Read no more than MAX_REQUEST_BYTES + 1 bytes before returning an error.
/// `lines()` allocates the entire attacker-controlled line first.
async fn read_bounded_line<R>(reader: &mut R) -> io::Result<Option<Vec<u8>>>
where
    R: AsyncBufRead + Unpin,
{
    let mut line = Vec::with_capacity(1024);
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return if line.is_empty() {
                Ok(None)
            } else {
                Ok(Some(line))
            };
        }
        let count = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |index| index + 1);
        if line.len().saturating_add(count) > MAX_REQUEST_BYTES + 1 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "worker request exceeds size limit",
            ));
        }
        let complete = available.get(count - 1) == Some(&b'\n');
        line.extend_from_slice(&available[..count]);
        reader.consume(count);
        if complete {
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            if line.len() > MAX_REQUEST_BYTES {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "worker request exceeds size limit",
                ));
            }
            return Ok(Some(line));
        }
    }
}

async fn write_envelope<W: AsyncWriteExt + Unpin>(
    write: &mut W,
    ok: bool,
    data: Value,
) -> Result<(), String> {
    let mut encoded =
        serde_json::to_vec(&Envelope { ok, data }).map_err(|error| error.to_string())?;
    if encoded.len() > MAX_RESPONSE_BYTES {
        encoded = serde_json::to_vec(&Envelope {
            ok: false,
            data: json!({"error":"response exceeds size limit"}),
        })
        .map_err(|error| error.to_string())?;
    }
    encoded.push(b'\n');
    tokio::time::timeout(IO_TIMEOUT, write.write_all(&encoded))
        .await
        .map_err(|_| "worker response timed out".to_string())?
        .map_err(|error| error.to_string())
}

async fn dispatch<C: ApiContext>(
    database: &Path,
    context: &C,
    request: Request,
) -> Result<Value, String> {
    if request.op == "health" {
        let database_ready = database_schema_ready(database).await;
        let ready = database_ready && context.mail_ready();
        let mail_status = read_mail_status(database).await;
        let account_status = read_mail_account_status(database).await;
        return Ok(json!({
            "protocol": 1,
            "state": if ready { "ready" } else { "starting" },
            "data_ready": ready,
            "mail_status": mail_status,
            "accounts": account_status,
        }));
    }
    if request.op == "wake" {
        context.notify_mail_changed("manual-wake".into());
        return Ok(json!({"woken":true}));
    }
    if request.op == "relay_reconfigure" {
        context.notify_relay_changed();
        context.notify_mail_changed("relay-reconfigured".into());
        return Ok(json!({"reconfigured":true}));
    }
    let profile = authenticate(context, &request)?;
    if !profile.has_scope("metadata") {
        return Err("profile does not grant metadata access".into());
    }
    if !database_schema_ready(database).await {
        return Err("mail database is not ready".into());
    }
    let options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(database)
        .read_only(true)
        .create_if_missing(false)
        .busy_timeout(Duration::from_secs(5));
    let mut db = SqliteConnection::connect_with(&options)
        .await
        .map_err(|_| "mail database is unavailable".to_string())?;

    match request.op.as_str() {
        "list_accounts" => {
            let rows = sqlx::query("SELECT id, email, display_name FROM accounts WHERE is_active = 1 ORDER BY created_at")
                .fetch_all(&mut db).await.map_err(|_| "could not read mail accounts".to_string())?;
            Ok(json!({"accounts":rows.iter().filter_map(|row| {
                let id = row.get::<String, _>("id");
                profile.allows_account(&id).then(|| json!({"id":id,"email":row.get::<String, _>("email"),"display_name":row.get::<Option<String>, _>("display_name")}))
            }).collect::<Vec<_>>() }))
        }
        "recent_messages" => {
            let account = permitted_account(&profile, request.account_id.as_deref())?;
            let cursor = match request.cursor {
                None => None,
                Some(Cursor::Message(value)) => Some(value),
                _ => return Err("message cursor is invalid".into()),
            };
            if cursor.as_ref().is_some_and(|value| {
                value.id.is_empty()
                    || value.id.len() > 2048
                    || value.id.bytes().any(|byte| byte.is_ascii_control())
            }) {
                return Err("message cursor is invalid".into());
            }
            let limit = request.limit.unwrap_or(50).clamp(1, MAX_PAGE_SIZE);
            let (cursor_date, cursor_id) = cursor
                .map(|value| (Some(value.date), Some(value.id)))
                .unwrap_or((None, None));
            let rows = sqlx::query(
                "SELECT id, thread_id, from_address, from_name, to_addresses, cc_addresses, date, is_read FROM messages \
                 WHERE account_id = ? AND is_read_receipt = 0 AND (? IS NULL OR date < ? OR (date = ? AND id < ?)) \
                 ORDER BY date DESC, id DESC LIMIT ?")
                .bind(&account).bind(cursor_date).bind(cursor_date).bind(cursor_date).bind(cursor_id).bind(limit)
                .fetch_all(&mut db).await.map_err(|_| "could not read mail metadata".to_string())?;
            let next_cursor = rows
                .last()
                .map(|row| json!({"date":row.get::<i64,_>("date"),"id":row.get::<String,_>("id")}));
            let messages = rows
                .iter()
                .map(|row| metadata_message(row, &account))
                .collect::<Vec<_>>();
            Ok(json!({"messages":messages,"next_cursor":next_cursor}))
        }
        "get_message" => {
            let account = permitted_account(&profile, request.account_id.as_deref())?;
            let message = request.message_id.as_deref().ok_or("message_id required")?;
            let row = sqlx::query("SELECT id, thread_id, from_address, from_name, to_addresses, cc_addresses, date, is_read FROM messages WHERE account_id = ? AND id = ? AND is_read_receipt = 0")
                .bind(&account).bind(message).fetch_optional(&mut db).await.map_err(|_| "could not read mail metadata".to_string())?;
            Ok(json!({"message":row.map(|row| metadata_message(&row, &account))}))
        }
        "get_content" => {
            if !profile.has_scope("read_content") {
                return Err("profile does not grant read_content access".into());
            }
            let account = permitted_account(&profile, request.account_id.as_deref())?;
            let message = request.message_id.as_deref().ok_or("message_id required")?;
            let row = sqlx::query("SELECT substr(subject,1,?), substr(snippet,1,?), substr(body_text,1,?), substr(body_html,1,?) FROM messages WHERE account_id = ? AND id = ? AND is_read_receipt = 0")
                .bind(MAX_CONTENT_CHARS + 1).bind(MAX_CONTENT_CHARS + 1)
                .bind(MAX_CONTENT_CHARS + 1).bind(MAX_CONTENT_CHARS + 1)
                .bind(account).bind(message).fetch_optional(&mut db).await.map_err(|_| "could not read message content".to_string())?;
            Ok(json!({"content":row.map(|row| {
                let subject = row.get::<Option<String>,_>(0);
                let snippet = row.get::<Option<String>,_>(1);
                let text = row.get::<Option<String>,_>(2);
                let html = row.get::<Option<String>,_>(3);
                let truncated = [&subject,&snippet,&text,&html].iter().any(|field| field.as_ref().is_some_and(|value| value.chars().count() as i64 > MAX_CONTENT_CHARS));
                let cap = |value: Option<String>| value.map(|value| value.chars().take(MAX_CONTENT_CHARS as usize).collect::<String>());
                json!({"subject":cap(subject),"snippet":cap(snippet),"text":cap(text),
                    "html":cap(html),"truncated":truncated})
            })}))
        }
        "changes" => changes(&mut db, &profile, request.cursor, request.limit).await,
        "search" => {
            if !profile.has_scope("read_content") {
                return Err("profile does not grant read_content access".into());
            }
            let query = request.query.as_deref().ok_or("query required")?;
            search_messages(
                &mut db,
                &profile,
                request.account_id.as_deref(),
                query,
                request.limit,
            )
            .await
        }
        _ => Err("unsupported operation".into()),
    }
}

async fn changes(
    db: &mut SqliteConnection,
    profile: &Profile,
    cursor: Option<Cursor>,
    limit: Option<i64>,
) -> Result<Value, String> {
    let after = match cursor {
        None => 0,
        Some(Cursor::Journal(value)) if value.seq >= 0 => value.seq,
        _ => return Err("change cursor is invalid".into()),
    };
    let limit = limit.unwrap_or(50).clamp(1, MAX_PAGE_SIZE);
    let head: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(seq),0) FROM worker_change_events")
        .fetch_one(&mut *db)
        .await
        .map_err(|_| "change journal is not ready".to_string())?;
    let first: Option<i64> = sqlx::query_scalar("SELECT MIN(seq) FROM worker_change_events")
        .fetch_one(&mut *db)
        .await
        .map_err(|_| "change journal is not ready".to_string())?;
    if after > head || first.is_some_and(|first| after < first.saturating_sub(1)) {
        return Ok(json!({"events":[],"next_cursor":head,"resync_required":true}));
    }
    if profile.account_ids.is_empty() {
        return Ok(json!({"events":[],"next_cursor":head.max(after),"resync_required":false}));
    }
    let placeholders = std::iter::repeat("?")
        .take(profile.account_ids.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!("SELECT seq, account_id, changed_at FROM worker_change_events WHERE seq > ? AND account_id IN ({placeholders}) ORDER BY seq ASC LIMIT ?");
    let mut query = sqlx::query(&sql).bind(after);
    for account in &profile.account_ids {
        query = query.bind(account);
    }
    let rows = query
        .bind(limit)
        .fetch_all(&mut *db)
        .await
        .map_err(|_| "could not read change journal".to_string())?;
    let events = rows.iter().map(|row| json!({"seq":row.get::<i64,_>("seq"),"account_id":row.get::<String,_>("account_id"),"changed_at":row.get::<i64,_>("changed_at")})).collect::<Vec<_>>();
    let last_seq = rows
        .last()
        .map(|row| row.get::<i64, _>("seq"))
        .unwrap_or(after);
    let next = if rows.len() as i64 >= limit {
        last_seq
    } else {
        head.max(last_seq).max(after)
    };
    Ok(json!({"events":events,"next_cursor":next,"resync_required":false}))
}

async fn search_messages(
    db: &mut SqliteConnection,
    profile: &Profile,
    requested_account: Option<&str>,
    query: &str,
    requested_limit: Option<i64>,
) -> Result<Value, String> {
    let query = query.trim();
    if query.is_empty()
        || query.chars().count() > MAX_SEARCH_QUERY_CHARS
        || query.chars().any(char::is_control)
    {
        return Err("search query must be 1-256 printable characters".into());
    }
    let accounts = if let Some(account) = requested_account {
        vec![permitted_account(profile, Some(account))?]
    } else {
        profile.account_ids.clone()
    };
    if accounts.is_empty() {
        return Ok(json!({"matches":[],"has_more":false}));
    }

    // A quoted FTS phrase keeps user input out of the FTS operator grammar;
    // SQL parameters separately prevent SQL injection. Quotes inside a phrase
    // are represented by doubled quotes per the FTS5 query syntax.
    let fts_phrase = format!("\"{}\"", query.replace('"', "\"\""));
    let placeholders = std::iter::repeat("?")
        .take(accounts.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT m.account_id, m.id, m.thread_id FROM messages_fts \
         JOIN messages AS m ON m.rowid = messages_fts.rowid \
         WHERE messages_fts MATCH ? AND m.account_id IN ({placeholders}) \
         AND m.is_read_receipt = 0 ORDER BY m.date DESC, m.id DESC LIMIT ?"
    );
    let limit = requested_limit.unwrap_or(50).clamp(1, MAX_PAGE_SIZE);
    let mut statement = sqlx::query(&sql).bind(fts_phrase);
    for account in &accounts {
        statement = statement.bind(account);
    }
    let rows = statement
        .bind(limit + 1)
        .fetch_all(&mut *db)
        .await
        .map_err(|_| "search could not be completed".to_string())?;
    let has_more = rows.len() as i64 > limit;
    let matches = rows
        .iter()
        .take(limit as usize)
        .map(|row| {
            let account = row.get::<String, _>("account_id");
            let message = row.get::<String, _>("id");
            let thread = row.get::<String, _>("thread_id");
            json!({
                "account_id": account,
                "message_id": message,
                "thread_id": thread,
                "link": mail_link(&account, &thread, Some(&message))
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({"matches":matches,"has_more":has_more}))
}

async fn serve_subscription<W: AsyncWriteExt + Unpin, C: ApiContext, R: AsyncRead + Unpin>(
    reader: &mut R,
    write: &mut W,
    database: &Path,
    context: &C,
    request: Request,
) -> Result<(), String> {
    let profile_id = request.profile_id.clone().ok_or("profile_id required")?;
    let token = request.token.clone().ok_or("profile token required")?;
    let profile = authenticate(context, &request)?;
    if !profile.has_scope("metadata") {
        return Err("profile does not grant metadata access".into());
    }
    if !database_schema_ready(database).await {
        return Err("mail database is not ready".into());
    }
    let after = match request.cursor {
        None => 0,
        Some(Cursor::Journal(value)) if value.seq >= 0 => value.seq,
        _ => return Err("change cursor is invalid".into()),
    };
    // Subscribe before replay, then cursor-filter against durable rows. An event
    // racing replay is therefore either in the replay or fetched after wake.
    let mut live = context.subscribe_mail_changes();
    let mut cursor = after;
    let mut db = open_readonly(database).await?;
    loop {
        let initial = changes(
            &mut db,
            &profile,
            Some(Cursor::Journal(JournalCursor { seq: cursor })),
            Some(100),
        )
        .await?;
        let next = initial["next_cursor"].as_i64().unwrap_or(cursor);
        let has_events = initial["events"]
            .as_array()
            .is_some_and(|events| !events.is_empty());
        write_envelope(write, true, initial).await?;
        if next <= cursor || !has_events {
            break;
        }
        cursor = next;
        if cursor >= db_head(&mut db).await? {
            break;
        }
    }
    let shutdown = context.shutdown_token();
    let mut revalidate = tokio::time::interval(context.revalidation_interval());
    revalidate.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            _ = shutdown.cancelled() => return Ok(()),
            disconnected = reader.read_u8() => {
                return match disconnected {
                    Ok(_) => Err("unexpected extra data on subscription".into()),
                    Err(_) => Ok(()),
                };
            }
            _ = revalidate.tick() => {
                let still_granted = context.profile(&profile_id, &token).is_ok_and(|current|
                    current.account_ids == profile.account_ids && current.scopes == profile.scopes);
                if !still_granted {
                    let _ = write_envelope(write,false,json!({"error":"profile capability revoked"})).await;
                    return Ok(());
                }
            }
            event = live.recv() => match event {
                Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    let mut db = open_readonly(database).await?;
                    let update = changes(&mut db,&profile,Some(Cursor::Journal(JournalCursor{seq:cursor})),Some(100)).await?;
                    let next = update["next_cursor"].as_i64().unwrap_or(cursor);
                    if next > cursor {
                        cursor = next;
                    }
                    if update["resync_required"] == true
                        || !update["events"].as_array().is_some_and(Vec::is_empty)
                    {
                        write_envelope(write,true,update).await?;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return Ok(()),
            }
        }
    }
}

async fn db_head(db: &mut SqliteConnection) -> Result<i64, String> {
    sqlx::query_scalar("SELECT COALESCE(MAX(seq),0) FROM worker_change_events")
        .fetch_one(db)
        .await
        .map_err(|_| "change journal is not ready".to_string())
}

async fn open_readonly(path: &Path) -> Result<SqliteConnection, String> {
    let options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .create_if_missing(false)
        .busy_timeout(Duration::from_secs(5));
    SqliteConnection::connect_with(&options)
        .await
        .map_err(|_| "mail database is unavailable".into())
}

async fn database_schema_ready(database: &Path) -> bool {
    if !database.is_file() {
        return false;
    }
    let Ok(mut db) = open_readonly(database).await else {
        return false;
    };
    let version = sqlx::query_scalar::<_, Option<i64>>("SELECT MAX(version) FROM _migrations")
        .fetch_optional(&mut db)
        .await
        .ok()
        .flatten()
        .flatten();
    version.is_some_and(|version| version >= MIN_SCHEMA_VERSION)
}

async fn read_mail_status(database: &Path) -> Option<Value> {
    let mut db = open_readonly(database).await.ok()?;
    let row = sqlx::query(
        "SELECT phase, account_id, error, updated_at FROM worker_mail_status WHERE id = 1",
    )
    .fetch_optional(&mut db)
    .await
    .ok()??;
    let phase = row.try_get::<Option<String>, _>("phase").ok().flatten()?;
    if !matches!(phase.as_str(), "ready" | "syncing" | "error") {
        return None;
    }
    let account_id = row
        .try_get::<Option<String>, _>("account_id")
        .ok()
        .flatten()
        .filter(|value| value.len() <= 256 && !value.bytes().any(|byte| byte.is_ascii_control()));
    let error = row
        .try_get::<Option<String>, _>("error")
        .ok()
        .flatten()
        .map(|value| {
            value
                .chars()
                .filter(|character| !character.is_control())
                .take(180)
                .collect::<String>()
        })
        .filter(|value| !value.is_empty());
    let updated_at = row.try_get::<Option<i64>, _>("updated_at").ok().flatten();
    Some(json!({
        "phase": phase,
        "account_id": account_id,
        "error": error,
        "updated_at": updated_at
    }))
}

async fn read_mail_account_status(database: &Path) -> Option<Vec<Value>> {
    let mut db = open_readonly(database).await.ok()?;
    let rows = sqlx::query(
        "SELECT account_id, phase, error, last_success_at, updated_at \
         FROM worker_mail_account_status ORDER BY account_id LIMIT 500",
    )
    .fetch_all(&mut db)
    .await
    .ok()?;
    Some(
        rows.iter()
            .filter_map(|row| {
                let account_id = row.try_get::<String, _>("account_id").ok()?;
                if account_id.len() > 256
                    || account_id.bytes().any(|byte| byte.is_ascii_control())
                {
                    return None;
                }
                let phase = row.try_get::<String, _>("phase").ok()?;
                if !matches!(phase.as_str(), "ready" | "syncing" | "error") {
                    return None;
                }
                let error = row
                    .try_get::<Option<String>, _>("error")
                    .ok()
                    .flatten()
                    .map(|value| {
                        value
                            .chars()
                            .filter(|character| !character.is_control())
                            .take(180)
                            .collect::<String>()
                    })
                    .filter(|value| !value.is_empty());
                Some(json!({
                    "account_id": account_id,
                    "phase": phase,
                    "error": error,
                    "last_success_at": row.try_get::<Option<i64>, _>("last_success_at").ok().flatten(),
                    "updated_at": row.try_get::<Option<i64>, _>("updated_at").ok().flatten(),
                }))
            })
            .collect(),
    )
}

fn authenticate<C: ApiContext>(context: &C, request: &Request) -> Result<Profile, String> {
    let profile_id = request.profile_id.as_deref().ok_or("profile_id required")?;
    let token = request.token.as_deref().ok_or("profile token required")?;
    if token.len() > 256 {
        return Err("invalid profile capability".into());
    }
    context.profile(profile_id, token)
}

fn permitted_account(profile: &Profile, account: Option<&str>) -> Result<String, String> {
    let account = account.ok_or("account_id required")?;
    if !profile.allows_account(account) {
        return Err("profile is not authorized for this account".into());
    }
    Ok(account.to_string())
}

fn metadata_message(row: &SqliteRow, account_id: &str) -> Value {
    let id = row.get::<String, _>("id");
    let thread_id = row.get::<String, _>("thread_id");
    json!({
        "id":id,
        "thread_id":thread_id,
        "from_address":row.get::<Option<String>,_>("from_address"),
        "from_name":row.get::<Option<String>,_>("from_name"),
        "to_addresses":row.get::<Option<String>,_>("to_addresses"),
        "cc_addresses":row.try_get::<Option<String>,_>("cc_addresses").ok().flatten(),
        "date":row.get::<i64,_>("date"),
        "is_read":row.get::<i64,_>("is_read") != 0,
        "link":mail_link(account_id,&thread_id,Some(&id))
    })
}

fn mail_link(account_id: &str, thread_id: &str, message_id: Option<&str>) -> String {
    let mut link = format!(
        "sndmail://open?account={}&thread={}",
        url_encode(account_id),
        url_encode(thread_id)
    );
    if let Some(message_id) = message_id {
        link.push_str("&message=");
        link.push_str(&url_encode(message_id));
    }
    link
}

fn url_encode(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

#[cfg(target_os = "macos")]
fn same_user(stream: &UnixStream) -> Result<bool, String> {
    use std::os::fd::AsRawFd;
    let mut uid: libc::uid_t = 0;
    let mut gid: libc::gid_t = 0;
    let rc = unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) };
    if rc != 0 {
        return Err("cannot authenticate worker socket client".into());
    }
    Ok(uid == unsafe { libc::geteuid() })
}

#[cfg(target_os = "linux")]
fn same_user(stream: &UnixStream) -> Result<bool, String> {
    use std::{mem, os::fd::AsRawFd};
    let mut credentials: libc::ucred = unsafe { mem::zeroed() };
    let mut length = mem::size_of::<libc::ucred>() as libc::socklen_t;
    let rc = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            &mut credentials as *mut _ as *mut libc::c_void,
            &mut length,
        )
    };
    if rc != 0 {
        return Err("cannot authenticate worker socket client".into());
    }
    Ok(credentials.uid == unsafe { libc::geteuid() })
}

#[cfg(all(unix, not(any(target_os = "macos", target_os = "linux"))))]
fn same_user(_stream: &UnixStream) -> Result<bool, String> {
    Err("peer credential checks are unsupported on this platform".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Mutex;
    use tokio::io::AsyncWriteExt;

    static NEXT_DB: AtomicU64 = AtomicU64::new(0);

    #[derive(Clone)]
    struct FixtureContext {
        profiles: Arc<Mutex<Vec<Profile>>>,
        shutdown: CancellationToken,
        events: broadcast::Sender<String>,
        relay_changes: Arc<std::sync::atomic::AtomicUsize>,
    }

    impl ApiContext for FixtureContext {
        fn mail_ready(&self) -> bool {
            true
        }
        fn notify_mail_changed(&self, account_id: String) {
            let _ = self.events.send(account_id);
        }
        fn notify_relay_changed(&self) {
            self.relay_changes.fetch_add(1, Ordering::SeqCst);
        }
        fn subscribe_mail_changes(&self) -> broadcast::Receiver<String> {
            self.events.subscribe()
        }
        fn shutdown_token(&self) -> CancellationToken {
            self.shutdown.clone()
        }
        fn revalidation_interval(&self) -> Duration {
            Duration::from_millis(20)
        }
        fn profile(&self, profile_id: &str, token: &str) -> Result<Profile, String> {
            self.profiles
                .lock()
                .unwrap()
                .iter()
                .find(|profile| profile.profile_id == profile_id && profile.verify_token(token))
                .cloned()
                .ok_or_else(|| "invalid profile capability".into())
        }
    }

    fn content_profile(profile_id: &str, token: &str, account_ids: &[&str]) -> Profile {
        let mut value =
            serde_json::to_value(Profile::fixture(profile_id, token, account_ids)).unwrap();
        value["scopes"] = json!(["metadata", "read_content"]);
        serde_json::from_value(value).unwrap()
    }

    #[tokio::test]
    async fn relay_reconfigure_is_separate_from_ordinary_wake() {
        let (events, _) = broadcast::channel(8);
        let context = FixtureContext {
            profiles: Arc::new(Mutex::new(Vec::new())),
            shutdown: CancellationToken::new(),
            events: events.clone(),
            relay_changes: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        };
        let mut receiver = events.subscribe();
        let wake: Request = serde_json::from_value(json!({"op":"wake"})).unwrap();
        assert_eq!(dispatch(Path::new("unused"), &context, wake).await.unwrap()["woken"], true);
        assert_eq!(receiver.recv().await.unwrap(), "manual-wake");
        assert_eq!(context.relay_changes.load(Ordering::SeqCst), 0);

        let reconfigure: Request = serde_json::from_value(json!({"op":"relay_reconfigure"})).unwrap();
        assert_eq!(dispatch(Path::new("unused"), &context, reconfigure).await.unwrap()["reconfigured"], true);
        assert_eq!(receiver.recv().await.unwrap(), "relay-reconfigured");
        assert_eq!(context.relay_changes.load(Ordering::SeqCst), 1);
    }

    async fn full_api_fixture() -> PathBuf {
        let nonce = NEXT_DB.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "sndmail-api-ipc-{}-{nonce}.sqlite",
            std::process::id()
        ));
        let options = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true);
        let mut db = SqliteConnection::connect_with(&options).await.unwrap();
        sqlx::query("CREATE TABLE _migrations(version INTEGER PRIMARY KEY)")
            .execute(&mut db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO _migrations VALUES(32)")
            .execute(&mut db)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE worker_mail_status(id INTEGER PRIMARY KEY, phase TEXT, account_id TEXT, error TEXT, updated_at INTEGER)")
            .execute(&mut db).await.unwrap();
        sqlx::query("INSERT INTO worker_mail_status VALUES(1,'error',NULL,'1 account needs attention',1000)")
            .execute(&mut db).await.unwrap();
        sqlx::query("CREATE TABLE worker_mail_account_status(account_id TEXT PRIMARY KEY, phase TEXT NOT NULL, error TEXT, last_success_at INTEGER, updated_at INTEGER NOT NULL)")
            .execute(&mut db).await.unwrap();
        sqlx::query("INSERT INTO worker_mail_account_status VALUES('account-a','error','provider authentication failed',900,1000),('account-b','ready',NULL,950,1000)")
            .execute(&mut db).await.unwrap();
        sqlx::query("CREATE TABLE messages(id TEXT UNIQUE, account_id TEXT, thread_id TEXT, from_address TEXT, from_name TEXT, to_addresses TEXT, cc_addresses TEXT, date INTEGER, is_read INTEGER, is_read_receipt INTEGER DEFAULT 0, subject TEXT, snippet TEXT, body_text TEXT, body_html TEXT)")
            .execute(&mut db).await.unwrap();
        sqlx::query("CREATE VIRTUAL TABLE messages_fts USING fts5(subject,from_name,from_address,body_text,snippet,content='messages',content_rowid='rowid',tokenize='trigram')")
            .execute(&mut db).await.unwrap();
        for (id, account, thread) in [
            ("a1", "account-a", "thread-a"),
            ("b1", "account-b", "thread-b"),
        ] {
            sqlx::query("INSERT INTO messages(id,account_id,thread_id,from_address,from_name,to_addresses,cc_addresses,date,is_read,is_read_receipt,subject,snippet,body_text,body_html) VALUES(?,?,?,'sender@example.test','Sender','me@example.test',NULL,100,0,0,'Your verification code 123456','private snippet','sharedneedle secret body','<p>sharedneedle secret body</p>')")
                .bind(id).bind(account).bind(thread).execute(&mut db).await.unwrap();
        }
        sqlx::query("INSERT INTO messages_fts(rowid,subject,from_name,from_address,body_text,snippet) SELECT rowid,subject,from_name,from_address,body_text,snippet FROM messages")
            .execute(&mut db).await.unwrap();
        sqlx::query("CREATE TABLE worker_change_events(seq INTEGER PRIMARY KEY, account_id TEXT NOT NULL, changed_at INTEGER NOT NULL)")
            .execute(&mut db).await.unwrap();
        for seq in 1..=203i64 {
            let account = if seq % 2 == 1 {
                "account-a"
            } else {
                "account-b"
            };
            sqlx::query(
                "INSERT INTO worker_change_events(seq,account_id,changed_at) VALUES(?,?,1000)",
            )
            .bind(seq)
            .bind(account)
            .execute(&mut db)
            .await
            .unwrap();
        }
        db.close().await.unwrap();
        path
    }

    async fn start_fixture_ipc(
        database: &Path,
        context: &FixtureContext,
    ) -> (
        UnixStream,
        tokio::task::JoinHandle<Result<(), String>>,
        PathBuf,
    ) {
        let nonce = NEXT_DB.fetch_add(1, Ordering::Relaxed);
        let socket =
            std::env::temp_dir().join(format!("sndapi-{}-{nonce}.sock", std::process::id()));
        let listener = UnixListener::bind(&socket).unwrap();
        let client = UnixStream::connect(&socket).await.unwrap();
        let (server, _) = listener.accept().await.unwrap();
        let database = database.to_path_buf();
        let context = context.clone();
        let task = tokio::spawn(async move { serve_client(server, &database, &context).await });
        drop(listener);
        (client, task, socket)
    }

    async fn request_fixture(
        reader: &mut (impl AsyncBufRead + Unpin),
        writer: &mut (impl AsyncWriteExt + Unpin),
        request: Value,
    ) -> Value {
        let mut bytes = serde_json::to_vec(&request).unwrap();
        bytes.push(b'\n');
        writer.write_all(&bytes).await.unwrap();
        let mut line = Vec::new();
        reader.read_until(b'\n', &mut line).await.unwrap();
        serde_json::from_slice(&line).unwrap()
    }

    async fn read_fixture_envelope<R: AsyncBufRead + Unpin>(reader: &mut R) -> Value {
        let mut line = Vec::new();
        reader.read_until(b'\n', &mut line).await.unwrap();
        serde_json::from_slice::<Value>(&line).unwrap()
    }

    #[tokio::test]
    async fn running_ipc_enforces_scope_account_filters_and_revokes_subscribers() {
        let database = full_api_fixture().await;
        let metadata = Profile::fixture("meta", "m-secret", &["account-a"]);
        let content = content_profile("content", "c-secret", &["account-a"]);
        let profiles = Arc::new(Mutex::new(vec![metadata, content]));
        let (events, _) = broadcast::channel(64);
        let context = FixtureContext {
            profiles: profiles.clone(),
            shutdown: CancellationToken::new(),
            events,
            relay_changes: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        };
        let (stream, task, socket) = start_fixture_ipc(&database, &context).await;
        let (read, mut write) = stream.into_split();
        let mut reader = BufReader::new(read);

        let health = request_fixture(&mut reader, &mut write, json!({"op":"health"})).await;
        assert_eq!(health["ok"], true);
        assert_eq!(health["data"]["state"], "ready");
        assert_eq!(health["data"]["mail_status"]["phase"], "error");
        assert_eq!(health["data"]["accounts"].as_array().unwrap().len(), 2);
        assert_eq!(
            health["data"]["accounts"][0]["error"],
            "provider authentication failed"
        );

        let invalid = request_fixture(
            &mut reader,
            &mut write,
            json!({
                "op":"list_accounts", "profile_id":"meta", "token":"wrong"
            }),
        )
        .await;
        assert_eq!(invalid["ok"], false);

        let no_search_scope = request_fixture(
            &mut reader,
            &mut write,
            json!({
                "op":"search", "profile_id":"meta", "token":"m-secret", "query":"sharedneedle"
            }),
        )
        .await;
        assert_eq!(no_search_scope["ok"], false);
        let no_content_scope = request_fixture(
            &mut reader,
            &mut write,
            json!({
                "op":"get_content", "profile_id":"meta", "token":"m-secret",
                "account_id":"account-a", "message_id":"a1"
            }),
        )
        .await;
        assert_eq!(no_content_scope["ok"], false);

        let cross_account = request_fixture(&mut reader, &mut write, json!({
            "op":"recent_messages", "profile_id":"meta", "token":"m-secret", "account_id":"account-b"
        })).await;
        assert_eq!(cross_account["ok"], false);
        let metadata = request_fixture(
            &mut reader,
            &mut write,
            json!({
                "op":"get_message", "profile_id":"meta", "token":"m-secret",
                "account_id":"account-a", "message_id":"a1"
            }),
        )
        .await;
        let metadata_json = metadata.to_string();
        assert_eq!(metadata["ok"], true);
        assert!(!metadata_json.contains("123456"));
        assert!(metadata_json.contains("sndmail://open?account=account-a"));

        let search = request_fixture(&mut reader, &mut write, json!({
            "op":"search", "profile_id":"content", "token":"c-secret", "query":"sharedneedle", "limit":100
        })).await;
        assert_eq!(search["ok"], true);
        assert_eq!(search["data"]["matches"].as_array().unwrap().len(), 1);
        assert_eq!(search["data"]["matches"][0]["account_id"], "account-a");
        assert_eq!(search["data"]["matches"][0]["message_id"], "a1");
        assert!(search["data"]["matches"][0].get("snippet").is_none());
        let denied_search = request_fixture(&mut reader, &mut write, json!({
            "op":"search", "profile_id":"content", "token":"c-secret", "query":"sharedneedle", "account_id":"account-b"
        })).await;
        assert_eq!(denied_search["ok"], false);

        let mut subscribe = serde_json::to_vec(&json!({
            "op":"subscribe", "profile_id":"meta", "token":"m-secret", "cursor":{"seq":0}
        }))
        .unwrap();
        subscribe.push(b'\n');
        write.write_all(&subscribe).await.unwrap();
        let page1 = read_fixture_envelope(&mut reader).await;
        let page2 = read_fixture_envelope(&mut reader).await;
        assert_eq!(page1["ok"], true);
        assert_eq!(page1["data"]["events"].as_array().unwrap().len(), 100);
        assert_eq!(page1["data"]["next_cursor"], 199);
        assert!(page1["data"]["events"]
            .as_array()
            .unwrap()
            .iter()
            .all(|event| event["account_id"] == "account-a"));
        assert_eq!(page2["ok"], true);
        assert_eq!(page2["data"]["events"].as_array().unwrap().len(), 2);
        assert_eq!(page2["data"]["next_cursor"], 203);
        assert!(page2["data"]["events"]
            .as_array()
            .unwrap()
            .iter()
            .all(|event| event["account_id"] == "account-a"));

        profiles
            .lock()
            .unwrap()
            .retain(|profile| profile.profile_id != "meta");
        let revoked =
            tokio::time::timeout(Duration::from_secs(1), read_fixture_envelope(&mut reader))
                .await
                .unwrap();
        assert_eq!(revoked["ok"], false);
        assert_eq!(revoked["data"]["error"], "profile capability revoked");
        drop(write);
        task.await.unwrap().unwrap();
        let _ = std::fs::remove_file(socket);
        let _ = std::fs::remove_file(database);
    }

    async fn journal_fixture(events: &[(i64, &str)]) -> (PathBuf, SqliteConnection) {
        let nonce = NEXT_DB.fetch_add(1, Ordering::Relaxed);
        let path =
            std::env::temp_dir().join(format!("sndmail-api-{}-{nonce}.sqlite", std::process::id()));
        let options = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true);
        let mut db = SqliteConnection::connect_with(&options).await.unwrap();
        sqlx::query("CREATE TABLE worker_change_events(seq INTEGER PRIMARY KEY, account_id TEXT NOT NULL, changed_at INTEGER NOT NULL)")
            .execute(&mut db).await.unwrap();
        for (seq, account) in events {
            sqlx::query(
                "INSERT INTO worker_change_events(seq,account_id,changed_at) VALUES(?,?,1000)",
            )
            .bind(seq)
            .bind(account)
            .execute(&mut db)
            .await
            .unwrap();
        }
        (path, db)
    }

    async fn message_fixture() -> SqliteConnection {
        let nonce = NEXT_DB.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "sndmail-api-message-{}-{nonce}.sqlite",
            std::process::id()
        ));
        let options = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true);
        let mut db = SqliteConnection::connect_with(&options).await.unwrap();
        sqlx::query("CREATE TABLE messages(id TEXT, thread_id TEXT, from_address TEXT, from_name TEXT, to_addresses TEXT, cc_addresses TEXT, date INTEGER, is_read INTEGER, subject TEXT, body_text TEXT)")
            .execute(&mut db).await.unwrap();
        sqlx::query("INSERT INTO messages VALUES('m1','t1','sender@example.test','Sender','me@example.test',NULL,10,0,'Your verification code 123456','OTP body 123456')")
            .execute(&mut db).await.unwrap();
        db
    }

    #[tokio::test]
    async fn oversized_unterminated_fixture_is_rejected_with_bounded_read() {
        let input = vec![b'x'; MAX_REQUEST_BYTES + 4096];
        let mut reader = BufReader::new(input.as_slice());
        let error = read_bounded_line(&mut reader).await.unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }

    #[tokio::test]
    async fn valid_fixture_line_is_returned_without_newline() {
        let input = b"{\"op\":\"health\"}\n";
        let mut reader = BufReader::new(input.as_slice());
        assert_eq!(
            read_bounded_line(&mut reader).await.unwrap(),
            Some(b"{\"op\":\"health\"}".to_vec())
        );
    }

    #[test]
    fn composite_message_cursor_requires_date_and_id() {
        let request: Request = serde_json::from_str(
            "{\"op\":\"recent_messages\",\"cursor\":{\"date\":12,\"id\":\"m1\"}}",
        )
        .unwrap();
        assert!(matches!(request.cursor, Some(Cursor::Message(_))));
        assert!(serde_json::from_str::<Request>(
            "{\"op\":\"recent_messages\",\"cursor\":{\"date\":12}}"
        )
        .is_err());
    }

    #[test]
    fn links_encode_reserved_identifier_characters() {
        assert_eq!(
            mail_link("acct 1", "thread&2", Some("msg/3")),
            "sndmail://open?account=acct%201&thread=thread%262&message=msg%2F3"
        );
    }

    #[test]
    fn capability_is_profile_bound_and_content_requires_explicit_scope() {
        let profile = Profile::fixture("commonplace", "secret", &["mail-a"]);
        assert!(profile.verify_token("secret"));
        assert!(!profile.verify_token("other-secret"));
        assert!(profile.allows_account("mail-a"));
        assert!(!profile.allows_account("mail-b"));
        assert!(profile.has_scope("metadata"));
        assert!(!profile.has_scope("read_content"));
        assert!(permitted_account(&profile, Some("mail-b")).is_err());
    }

    #[tokio::test]
    async fn metadata_fixture_never_returns_subject_or_body_codes() {
        let mut db = message_fixture().await;
        let row = sqlx::query("SELECT id, thread_id, from_address, from_name, to_addresses, cc_addresses, date, is_read FROM messages WHERE id='m1'")
            .fetch_one(&mut db).await.unwrap();
        let metadata = metadata_message(&row, "account-1");
        let encoded = serde_json::to_string(&metadata).unwrap();
        assert!(!encoded.contains("123456"));
        assert!(!encoded.contains("subject"));
        assert!(!encoded.contains("body_text"));
        assert!(encoded.contains("sndmail://open?account=account-1&thread=t1&message=m1"));
    }

    #[tokio::test]
    async fn journal_pagination_uses_global_seq_and_filters_bound_accounts() {
        let (path, mut db) = journal_fixture(&[(1, "a"), (2, "b"), (3, "a"), (4, "a")]).await;
        let profile = Profile::fixture("commonplace", "secret", &["a"]);
        let page1 = changes(&mut db, &profile, None, Some(1)).await.unwrap();
        assert_eq!(page1["events"][0]["seq"], 1);
        assert_eq!(page1["next_cursor"], 1);
        assert_eq!(page1["resync_required"], false);
        let page2 = changes(
            &mut db,
            &profile,
            Some(Cursor::Journal(JournalCursor { seq: 1 })),
            Some(1),
        )
        .await
        .unwrap();
        assert_eq!(page2["events"][0]["seq"], 3);
        assert_eq!(page2["next_cursor"], 3);
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn expired_journal_cursor_requires_resync_instead_of_skipping_changes() {
        let (path, mut db) = journal_fixture(&[(10, "a"), (11, "b")]).await;
        let profile = Profile::fixture("commonplace", "secret", &["a"]);
        let page = changes(
            &mut db,
            &profile,
            Some(Cursor::Journal(JournalCursor { seq: 2 })),
            Some(100),
        )
        .await
        .unwrap();
        assert_eq!(page["resync_required"], true);
        assert_eq!(page["next_cursor"], 11);
        assert_eq!(page["events"].as_array().unwrap().len(), 0);
        let _ = std::fs::remove_file(path);
    }
}
