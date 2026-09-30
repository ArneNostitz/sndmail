//! One-time code detection and durable notification dedup for the headless
//! worker. Clipboard changes only when the user presses Copy in the OS banner.

use regex::Regex;
use sqlx::{Connection, Row, SqliteConnection, sqlite::SqliteConnectOptions};
use std::collections::HashSet;
use std::sync::{mpsc, Arc, Mutex, OnceLock};

const MAX_AGE_MS: i64 = 10 * 60 * 1000;

pub(super) async fn maybe_notify(
    db: &mut SqliteConnection,
    account: &str,
    thread: &str,
    message: &str,
    subject: Option<&str>,
    body: Option<&str>,
    date_ms: i64,
    sender: Option<&str>,
) -> Result<(), String> {
    let now = chrono::Utc::now().timestamp_millis();
    if date_ms <= 0 || date_ms > now + 60_000 || now - date_ms > MAX_AGE_MS {
        return Ok(());
    }
    let enabled: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'otp_detection'")
        .fetch_optional(&mut *db).await.map_err(|e| format!("OTP setting: {e}"))?;
    if enabled.as_deref() == Some("false") { return Ok(()); }
    let notifications_enabled: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'notifications_enabled'")
        .fetch_optional(&mut *db).await.map_err(|e| format!("OTP setting: {e}"))?;
    if notifications_enabled.as_deref() == Some("false") { return Ok(()); }
    let notify_accounts: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'notify_accounts'")
        .fetch_optional(&mut *db).await.map_err(|e| format!("OTP setting: {e}"))?;
    if notify_accounts.as_deref().is_some_and(|v| !v.split(',').any(|item| item.trim() == account)) { return Ok(()); }
    let Some(code) = subject.and_then(detect).or_else(|| body.and_then(detect)) else { return Ok(()); };
    sqlx::query("INSERT OR IGNORE INTO worker_otp_notifications (account_id, message_id) VALUES (?, ?)")
        .bind(account).bind(message).execute(&mut *db).await.map_err(|e| format!("OTP dedup: {e}"))?;
    let delivered: i64 = sqlx::query("SELECT delivered FROM worker_otp_notifications WHERE account_id = ? AND message_id = ?")
        .bind(account).bind(message).fetch_one(&mut *db).await.map_err(|e| format!("OTP dedup: {e}"))?
        .get("delivered");
    if delivered != 0 { return Ok(()); }
    let mut url = reqwest::Url::parse("sndmail://open").expect("fixed mail link base");
    url.query_pairs_mut().append_pair("account", account).append_pair("thread", thread).append_pair("message", message);
    dispatch(db, NotificationJob::Code {
        code,
        sender: sender.unwrap_or("Your mail").to_owned(),
        account: account.to_owned(), message: message.to_owned(), link: url.to_string(),
    }).await?;
    Ok(())
}

pub(super) async fn maybe_notify_mail(
    db: &mut SqliteConnection,
    account: &str,
    thread: &str,
    message: &str,
    subject: Option<&str>,
    body: Option<&str>,
    date_ms: i64,
    from_address: Option<&str>,
) -> Result<(), String> {
    let now = chrono::Utc::now().timestamp_millis();
    if date_ms <= 0 || date_ms > now + 60_000 || now - date_ms > MAX_AGE_MS { return Ok(()); }
    if subject.and_then(detect).or_else(|| body.and_then(detect)).is_some() { return Ok(()); }
    let enabled: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'notifications_enabled'")
        .fetch_optional(&mut *db).await.map_err(|e| format!("mail notification setting: {e}"))?;
    if enabled.as_deref() == Some("false") { return Ok(()); }
    let accounts: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'notify_accounts'")
        .fetch_optional(&mut *db).await.map_err(|e| format!("mail notification setting: {e}"))?;
    if accounts.as_deref().is_some_and(|v| !v.split(',').any(|item| item.trim() == account)) { return Ok(()); }
    let smart: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'smart_notifications'")
        .fetch_optional(&mut *db).await.map_err(|e| format!("mail notification setting: {e}"))?;
    if smart.as_deref() != Some("false") {
        let vip: bool = if let Some(from) = from_address {
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM notification_vips WHERE account_id = ? AND lower(email_address) = lower(?)")
                .bind(account).bind(from).fetch_one(&mut *db).await.unwrap_or(0) > 0
        } else { false };
        if !vip {
            let category: Option<String> = sqlx::query_scalar("SELECT category FROM thread_categories WHERE account_id = ? AND thread_id = ?")
                .bind(account).bind(thread).fetch_optional(&mut *db).await.unwrap_or(None);
            let category = category.as_deref().unwrap_or("Primary");
            let allowed: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'notify_categories'")
                .fetch_optional(&mut *db).await.map_err(|e| format!("mail notification setting: {e}"))?;
            let allowed = allowed.as_deref().unwrap_or("Primary");
            if !allowed.split(',').any(|item| item.trim() == category) { return Ok(()); }
        }
    }
    sqlx::query("INSERT OR IGNORE INTO worker_mail_notifications (account_id, message_id) VALUES (?, ?)")
        .bind(account).bind(message).execute(&mut *db).await.map_err(|e| format!("mail notification dedup: {e}"))?;
    let delivered: i64 = sqlx::query("SELECT delivered FROM worker_mail_notifications WHERE account_id = ? AND message_id = ?")
        .bind(account).bind(message).fetch_one(&mut *db).await.map_err(|e| format!("mail notification dedup: {e}"))?.get("delivered");
    if delivered != 0 { return Ok(()); }
    let mut url = reqwest::Url::parse("sndmail://open").expect("fixed mail link base");
    url.query_pairs_mut().append_pair("account", account).append_pair("thread", thread).append_pair("message", message);
    dispatch(db, NotificationJob::Mail {
        sender: from_address.unwrap_or("New mail").to_owned(),
        subject: subject.unwrap_or("(No subject)").to_owned(),
        account: account.to_owned(), message: message.to_owned(), link: url.to_string(),
    }).await?;
    Ok(())
}

enum NotificationJob {
    Code { code: String, sender: String, account: String, message: String, link: String },
    Mail { sender: String, subject: String, account: String, message: String, link: String },
}

impl NotificationJob {
    fn identity(&self) -> String {
        match self {
            Self::Code { account, message, .. } => format!("code:{account}:{message}"),
            Self::Mail { account, message, .. } => format!("mail:{account}:{message}"),
        }
    }
}

pub(super) async fn retry_pending(db: &mut SqliteConnection) -> Result<(), String> {
    let now = chrono::Utc::now().timestamp_millis();
    for table in ["worker_otp_notifications", "worker_mail_notifications"] {
        let query = format!("SELECT n.account_id, n.message_id, m.thread_id, m.subject, m.body_text, m.body_html, m.date, m.from_address FROM {table} n JOIN messages m ON m.account_id = n.account_id AND m.id = n.message_id JOIN threads t ON t.account_id = m.account_id AND t.id = m.thread_id WHERE n.delivered = 0 AND m.date BETWEEN ? AND ? AND m.is_read = 0 AND COALESCE(t.is_muted, 0) = 0 AND EXISTS (SELECT 1 FROM thread_labels l WHERE l.account_id = m.account_id AND l.thread_id = m.thread_id AND l.label_id = 'INBOX') AND NOT EXISTS (SELECT 1 FROM thread_labels l WHERE l.account_id = m.account_id AND l.thread_id = m.thread_id AND l.label_id IN ('SPAM','TRASH')) ORDER BY n.created_at DESC LIMIT 32");
        let rows = sqlx::query(&query).bind(now - MAX_AGE_MS).bind(now + 60_000)
            .fetch_all(&mut *db).await.map_err(|e| format!("notification retry: {e}"))?;
        for row in rows {
            let account: String = row.get("account_id");
            let message: String = row.get("message_id");
            let thread: String = row.get("thread_id");
            let subject: Option<String> = row.get("subject");
            let body: Option<String> = row.get::<Option<String>, _>("body_text")
                .or_else(|| row.get("body_html"));
            let date: i64 = row.get("date");
            let from: Option<String> = row.get("from_address");
            if table == "worker_otp_notifications" {
                maybe_notify(db, &account, &thread, &message, subject.as_deref(), body.as_deref(), date, from.as_deref()).await?;
            } else {
                maybe_notify_mail(db, &account, &thread, &message, subject.as_deref(), body.as_deref(), date, from.as_deref()).await?;
            }
        }
    }
    Ok(())
}

async fn dispatch(db: &mut SqliteConnection, job: NotificationJob) -> Result<(), String> {
    let database: String = sqlx::query("PRAGMA database_list")
        .fetch_all(&mut *db).await.map_err(|e| format!("notification database: {e}"))?
        .into_iter().find(|row| row.get::<String, _>("name") == "main")
        .map(|row| row.get::<String, _>("file"))
        .ok_or("notification database unavailable")?;
    let queue = delivery_queue()?;
    let identity = job.identity();
    if !queue.in_flight.lock().map_err(|_| "notification state unavailable")?.insert(identity.clone()) {
        return Ok(());
    }
    if queue.sender.try_send((database, job)).is_err() {
        if let Ok(mut state) = queue.in_flight.lock() { state.remove(&identity); }
        // The durable intent row remains for the next bounded retry cycle.
        return Err("notification delivery queue is full".into());
    }
    Ok(())
}

struct DeliveryQueue {
    sender: mpsc::SyncSender<(String, NotificationJob)>,
    in_flight: Arc<Mutex<HashSet<String>>>,
}

fn delivery_queue() -> Result<&'static DeliveryQueue, String> {
    static QUEUE: OnceLock<DeliveryQueue> = OnceLock::new();
    if let Some(queue) = QUEUE.get() { return Ok(queue); }
    let (sender, receiver) = mpsc::sync_channel::<(String, NotificationJob)>(64);
    let in_flight = Arc::new(Mutex::new(HashSet::new()));
    let held = in_flight.clone();
    std::thread::Builder::new().name("sndmail-notifications".into()).spawn(move || {
        let Ok(runtime) = tokio::runtime::Builder::new_current_thread().enable_all().build() else { return; };
        for (database, job) in receiver {
            let identity = job.identity();
            runtime.block_on(async {
                let shown = match &job {
                    NotificationJob::Code { code, sender, account, message, link } =>
                        native::show(code, sender, account, message, link).await,
                    NotificationJob::Mail { sender, subject, account, message, link } =>
                        native::show_mail(sender, subject, account, message, link).await,
                };
                let permission = native::authorization_status().await;
                let options = SqliteConnectOptions::new().filename(database).create_if_missing(false)
                    .busy_timeout(std::time::Duration::from_secs(5));
                if let Ok(mut connection) = SqliteConnection::connect_with(&options).await {
                    let phase = if shown.is_ok() { "ready" } else { "error" };
                    let error = shown.as_ref().err().map(|e| notification_error_category(e));
                    let _ = sqlx::query("INSERT INTO worker_notification_status (id, phase, permission, error) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET phase=excluded.phase, permission=excluded.permission, error=excluded.error, updated_at=unixepoch()")
                        .bind(phase).bind(permission).bind(error).execute(&mut connection).await;
                    if shown.is_ok() {
                        let (table, account, message) = match &job {
                            NotificationJob::Code { account, message, .. } => ("worker_otp_notifications", account, message),
                            NotificationJob::Mail { account, message, .. } => ("worker_mail_notifications", account, message),
                        };
                        let statement = format!("UPDATE {table} SET delivered = 1 WHERE account_id = ? AND message_id = ?");
                        let _ = sqlx::query(&statement).bind(account).bind(message).execute(&mut connection).await;
                    }
                }
                match shown {
                    Ok(()) => {},
                    Err(error) => eprintln!("sndmail worker notification: {}", notification_error_category(&error)),
                }
            });
            if let Ok(mut state) = held.lock() { state.remove(&identity); }
        }
    }).map_err(|_| "cannot start notification delivery")?;
    let _ = QUEUE.set(DeliveryQueue { sender, in_flight });
    QUEUE.get().ok_or("notification delivery unavailable".into())
}

fn notification_error_category(error: &str) -> &'static str {
    if error.contains("permission timed out") { "permission_timeout" }
    else if error.contains("permission denied") { "permission_denied" }
    else if error.contains("categories timed out") { "categories_timeout" }
    else if error.contains("rejected request") { "request_rejected" }
    else if error.contains("bundle identity") { "bundle_identity" }
    else { "delivery_unavailable" }
}

fn detect(text: &str) -> Option<String> {
    static KEYWORD: OnceLock<Regex> = OnceLock::new();
    static CODE: OnceLock<Regex> = OnceLock::new();
    let keyword = KEYWORD.get_or_init(|| Regex::new(r"(?i)\b(?:one[ -]?time code|verification code|security code|login code|sign[ -]?in code|passcode|otp|2fa|two[ -]?factor|bestätigungscode|verifizierungscode|anmeldecode|einmalcode|code de vérification|código de verificación|codice di verifica)\b").expect("fixed OTP keywords"));
    let code = CODE.get_or_init(|| Regex::new(r"\b(?:[0-9]{4,8}|[A-Z0-9]{6,8})\b").expect("fixed OTP code"));
    for mention in keyword.find_iter(text) {
        let mut start = mention.start().saturating_sub(60);
        let mut end = (mention.end() + 60).min(text.len());
        while !text.is_char_boundary(start) { start -= 1; }
        while !text.is_char_boundary(end) { end += 1; }
        let around = &text[start..end];
        for candidate in code.find_iter(around) {
            let value = candidate.as_str();
            if value.bytes().all(|b| b.is_ascii_digit()) {
                if value.bytes().all(|b| b == value.as_bytes()[0]) { continue; }
                if value.len() == 4 && value.parse::<u16>().is_ok_and(|year| (1900..=2200).contains(&year)) { continue; }
                return Some(value.to_owned());
            }
            if value.bytes().any(|b| b.is_ascii_digit()) && value.bytes().any(|b| b.is_ascii_alphabetic()) {
                return Some(value.to_owned());
            }
        }
    }
    None
}

#[cfg(target_os = "macos")]
mod native {
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, Bool, ProtocolObject};
    use objc2::{define_class, msg_send, AnyThread};
    use objc2_foundation::{NSArray, NSBundle, NSDictionary, NSError, NSObject, NSObjectProtocol, NSSet, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNAuthorizationStatus, UNMutableNotificationContent, UNNotification,
        UNNotificationAction, UNNotificationActionOptions, UNNotificationCategory,
        UNNotificationCategoryOptions, UNNotificationPresentationOptions,
        UNNotificationRequest, UNNotificationResponse, UNNotificationSound,
        UNNotificationDefaultActionIdentifier,
        UNUserNotificationCenter, UNUserNotificationCenterDelegate,
    };
    use std::io::Write;
    use std::sync::{Mutex, OnceLock};

    const CATEGORY: &str = "sndmail-worker-otp";
    const COPY: &str = "copy-code";
    const CONTEXT: &str = "sndmail-worker-code";
    const LINK: &str = "sndmail-worker-link";

    struct Ivars;
    define_class!(
        #[unsafe(super(NSObject))]
        #[name = "SndmailWorkerNotificationDelegate"]
        #[ivars = Ivars]
        struct Delegate;

        unsafe impl NSObjectProtocol for Delegate {}
        unsafe impl UNUserNotificationCenterDelegate for Delegate {
            #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
            fn userNotificationCenter_willPresentNotification_withCompletionHandler(
                &self, _center: &UNUserNotificationCenter, _notification: &UNNotification,
                completion: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
            ) {
                completion.call((UNNotificationPresentationOptions::Banner
                    | UNNotificationPresentationOptions::List
                    | UNNotificationPresentationOptions::Sound,));
            }

            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn userNotificationCenter_didReceiveNotificationResponse_withCompletionHandler(
                &self, _center: &UNUserNotificationCenter, response: &UNNotificationResponse,
                completion: &block2::DynBlock<dyn Fn()>,
            ) {
                let action = response.actionIdentifier().to_string();
                if action == COPY {
                    let info = response.notification().request().content().userInfo();
                    let key = NSString::from_str(CONTEXT);
                    let key: &AnyObject = &key;
                    let code = info.objectForKey(key).and_then(|v| v.downcast_ref::<NSString>().map(ToString::to_string));
                    if let Some(code) = code {
                        let mut child = std::process::Command::new("/usr/bin/pbcopy")
                            .stdin(std::process::Stdio::piped()).spawn();
                        if let Ok(ref mut child) = child {
                            if let Some(mut input) = child.stdin.take() {
                                let _ = input.write_all(code.as_bytes());
                            }
                            let _ = child.wait();
                        }
                    }
                } else if unsafe { &*response.actionIdentifier() == UNNotificationDefaultActionIdentifier } {
                    let info = response.notification().request().content().userInfo();
                    let key = NSString::from_str(LINK);
                    let key: &AnyObject = &key;
                    let link = info.objectForKey(key).and_then(|v| v.downcast_ref::<NSString>().map(ToString::to_string));
                    if let Some(link) = link {
                        let _ = std::process::Command::new("/usr/bin/open").arg(link).spawn();
                    }
                }
                completion.call(());
            }
        }
    );

    impl Delegate {
        fn new() -> Retained<Self> {
            let this = Self::alloc().set_ivars(Ivars);
            unsafe { msg_send![super(this), init] }
        }
    }
    struct Held(#[allow(dead_code)] Retained<Delegate>);
    unsafe impl Send for Held {}
    unsafe impl Sync for Held {}
    static DELEGATE: OnceLock<Held> = OnceLock::new();

    pub(super) async fn authorization_status() -> &'static str {
        let bundle = NSBundle::mainBundle();
        if bundle.bundleIdentifier().is_none() || !bundle.bundlePath().to_string().ends_with(".app") {
            return "not_determined";
        }
        let (tx, rx) = tokio::sync::oneshot::channel();
        let tx = Mutex::new(Some(tx));
        let callback = RcBlock::new(move |settings: std::ptr::NonNull<objc2_user_notifications::UNNotificationSettings>| {
            let status = unsafe { settings.as_ref() }.authorizationStatus();
            let name = if status == UNAuthorizationStatus::Authorized || status == UNAuthorizationStatus::Provisional { "authorized" }
                else if status == UNAuthorizationStatus::Denied { "denied" }
                else { "not_determined" };
            if let Some(tx) = tx.lock().ok().and_then(|mut slot| slot.take()) { let _ = tx.send(name); }
        });
        UNUserNotificationCenter::currentNotificationCenter().getNotificationSettingsWithCompletionHandler(&callback);
        match tokio::time::timeout(std::time::Duration::from_secs(5), rx).await {
            Ok(Ok(status)) => status,
            _ => "timeout",
        }
    }

    async fn initialize() -> Result<(), String> {
        if DELEGATE.get().is_some() { return Ok(()); }
        let bundle = NSBundle::mainBundle();
        if bundle.bundleIdentifier().is_none() || !bundle.bundlePath().to_string().ends_with(".app") {
            return Err("worker has no app bundle identity".into());
        }
        let center = UNUserNotificationCenter::currentNotificationCenter();
        let (tx, rx) = tokio::sync::oneshot::channel();
        let tx = Mutex::new(Some(tx));
        let callback = RcBlock::new(move |existing: std::ptr::NonNull<NSSet<UNNotificationCategory>>| {
            let action = UNNotificationAction::actionWithIdentifier_title_options(
                &NSString::from_str(COPY), &NSString::from_str("Copy code"), UNNotificationActionOptions::empty(),
            );
            let category = UNNotificationCategory::categoryWithIdentifier_actions_intentIdentifiers_options(
                &NSString::from_str(CATEGORY), &NSArray::from_retained_slice(&[action]),
                &NSArray::<NSString>::new(), UNNotificationCategoryOptions::empty(),
            );
            let mut categories: Vec<Retained<UNNotificationCategory>> = unsafe { existing.as_ref() }
                .allObjects().iter()
                .filter(|item| item.identifier().to_string() != CATEGORY)
                .map(|item| item.to_owned())
                .collect();
            categories.push(category);
            UNUserNotificationCenter::currentNotificationCenter()
                .setNotificationCategories(&NSSet::from_retained_slice(&categories));
            if let Some(tx) = tx.lock().ok().and_then(|mut slot| slot.take()) { let _ = tx.send(()); }
        });
        center.getNotificationCategoriesWithCompletionHandler(&callback);
        tokio::time::timeout(std::time::Duration::from_secs(5), rx).await
            .map_err(|_| "notification categories timed out".to_string())?
            .map_err(|_| "notification categories unavailable".to_string())?;
        let delegate = Delegate::new();
        center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        let _ = DELEGATE.set(Held(delegate));
        Ok(())
    }

    async fn permission() -> Result<bool, String> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let tx = Mutex::new(Some(tx));
        let callback = RcBlock::new(move |granted: Bool, error: *mut NSError| {
            let ok = error.is_null() && granted.as_bool();
            if let Some(tx) = tx.lock().ok().and_then(|mut slot| slot.take()) { let _ = tx.send(ok); }
        });
        UNUserNotificationCenter::currentNotificationCenter().requestAuthorizationWithOptions_completionHandler(
            UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound, &callback,
        );
        rx.await.map_err(|_| "notification permission did not answer".to_string())
    }

    pub(super) async fn show(code: &str, sender: &str, account: &str, message: &str, link: &str) -> Result<(), String> {
        initialize().await?;
        if !tokio::time::timeout(std::time::Duration::from_secs(10), permission()).await
            .map_err(|_| "notification permission timed out".to_string())?? { return Err("notification permission denied".into()); }
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str("One-time code"));
        content.setBody(&NSString::from_str(&format!("{sender}: {code}")));
        content.setCategoryIdentifier(&NSString::from_str(CATEGORY));
        content.setSound(Some(&UNNotificationSound::defaultSound()));
        let info = NSDictionary::from_slices::<NSString>(
            &[&*NSString::from_str(CONTEXT), &*NSString::from_str(LINK)],
            &[&*NSString::from_str(code), &*NSString::from_str(link)],
        );
        unsafe { content.setUserInfo(&Retained::cast_unchecked::<NSDictionary>(info)) };
        let id = format!("sndmail-worker-otp-{:x}", md5::compute(format!("{account}:{message}")));
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
            &NSString::from_str(&id), &content, None,
        );
        let (tx, rx) = tokio::sync::oneshot::channel();
        let tx = Mutex::new(Some(tx));
        let callback = RcBlock::new(move |error: *mut NSError| {
            let ok = error.is_null();
            if let Some(tx) = tx.lock().ok().and_then(|mut slot| slot.take()) { let _ = tx.send(ok); }
        });
        UNUserNotificationCenter::currentNotificationCenter()
            .addNotificationRequest_withCompletionHandler(&request, Some(&callback));
        match tokio::time::timeout(std::time::Duration::from_secs(10), rx).await {
            Ok(Ok(true)) => Ok(()),
            _ => Err("notification center rejected request".into()),
        }
    }

    pub(super) async fn show_mail(sender: &str, subject: &str, account: &str, message: &str, link: &str) -> Result<(), String> {
        initialize().await?;
        if !tokio::time::timeout(std::time::Duration::from_secs(10), permission()).await
            .map_err(|_| "notification permission timed out".to_string())?? { return Err("notification permission denied".into()); }
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(&sender.chars().take(160).collect::<String>()));
        content.setBody(&NSString::from_str(&subject.chars().take(200).collect::<String>()));
        content.setSound(Some(&UNNotificationSound::defaultSound()));
        let info = NSDictionary::from_slices::<NSString>(&[&*NSString::from_str(LINK)], &[&*NSString::from_str(link)]);
        unsafe { content.setUserInfo(&Retained::cast_unchecked::<NSDictionary>(info)) };
        let id = format!("sndmail-worker-mail-{:x}", md5::compute(format!("{account}:{message}")));
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(&NSString::from_str(&id), &content, None);
        let (tx, rx) = tokio::sync::oneshot::channel();
        let tx = Mutex::new(Some(tx));
        let callback = RcBlock::new(move |error: *mut NSError| {
            if let Some(tx) = tx.lock().ok().and_then(|mut slot| slot.take()) { let _ = tx.send(error.is_null()); }
        });
        UNUserNotificationCenter::currentNotificationCenter().addNotificationRequest_withCompletionHandler(&request, Some(&callback));
        match tokio::time::timeout(std::time::Duration::from_secs(10), rx).await {
            Ok(Ok(true)) => Ok(()),
            _ => Err("notification center rejected request".into()),
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod native {
    pub(super) async fn authorization_status() -> &'static str { "not_determined" }
    pub(super) async fn show(_code: &str, _sender: &str, _account: &str, _message: &str, _link: &str) -> Result<(), String> {
        Err("native OTP actions require macOS".into())
    }
    pub(super) async fn show_mail(_sender: &str, _subject: &str, _account: &str, _message: &str, _link: &str) -> Result<(), String> {
        Err("native mail notifications require macOS".into())
    }
}

#[cfg(test)]
mod tests {
    use super::detect;
    #[test]
    fn finds_sign_in_code_but_not_order_number() {
        assert_eq!(detect("Your verification code is 581942").as_deref(), Some("581942"));
        assert_eq!(detect("Order number 581942"), None);
        assert_eq!(detect("Your verification code is 111111"), None);
    }
}
