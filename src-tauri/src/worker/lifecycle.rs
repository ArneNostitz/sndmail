use std::fs::{self, OpenOptions};
use std::io::{Seek, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tokio::sync::{broadcast, Notify};
use tokio_util::sync::CancellationToken;

use super::api;
use super::mail;

/// Shared shutdown and wake-up signals for the mail worker.
#[derive(Clone)]
pub(crate) struct WorkerContext {
    shutdown: CancellationToken,
    mail_changed: Arc<Notify>,
    relay_changed: Arc<Notify>,
    mail_events: broadcast::Sender<String>,
    mail_ready: Arc<AtomicBool>,
}

impl WorkerContext {
    pub(crate) fn shutdown(&self) -> CancellationToken {
        self.shutdown.clone()
    }

    /// Coalesce bursts of push/IDLE notifications into one sync wake-up.
    pub(crate) fn notify_mail_changed(&self, account_id: String) {
        self.mail_changed.notify_one();
        let _ = self.mail_events.send(account_id);
    }

    pub(crate) fn notify_relay_changed(&self) {
        self.relay_changed.notify_one();
    }

    pub(crate) async fn wait_for_relay_change(&self) {
        self.relay_changed.notified().await;
    }

    pub(crate) fn subscribe_mail_changes(&self) -> broadcast::Receiver<String> {
        self.mail_events.subscribe()
    }

    /// Publish a completed sync to API clients without waking the sync loop.
    pub(crate) fn emit_mail_synced(&self, account_id: String) {
        let _ = self.mail_events.send(account_id);
    }

    pub(crate) fn set_mail_ready(&self, ready: bool) {
        self.mail_ready.store(ready, Ordering::Release);
    }

    pub(crate) fn mail_ready(&self) -> bool {
        self.mail_ready.load(Ordering::Acquire)
    }

    pub(crate) fn data_dir(&self) -> Result<PathBuf, String> {
        let directory = app_support_dir()?;
        fs::create_dir_all(&directory)
            .map_err(|error| format!("create worker data directory: {error}"))?;
        Ok(directory)
    }

    pub(crate) fn socket_path(&self) -> Result<PathBuf, String> {
        let directory = app_support_dir()?;
        fs::create_dir_all(&directory)
            .map_err(|error| format!("create worker data directory: {error}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
                .map_err(|error| format!("restrict worker data directory: {error}"))?;
        }
        Ok(directory.join("worker.sock"))
    }

    pub(crate) async fn wait_for_mail_change(&self) {
        self.mail_changed.notified().await;
    }
}

struct OwnerLock(std::fs::File);

impl OwnerLock {
    fn acquire() -> Result<Self, String> {
        let path = app_support_dir()?.join("worker.lock");
        fs::create_dir_all(path.parent().expect("lock has parent"))
            .map_err(|error| format!("create worker data directory: {error}"))?;

        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .open(&path)
            .map_err(|error| format!("open worker owner lock: {error}"))?;
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
            if rc != 0 {
                return Err("another sndmail worker already owns mail background work".into());
            }
        }
        #[cfg(not(unix))]
        {
            return Err("native worker ownership is not implemented on this platform".into());
        }
        file.set_len(0)
            .map_err(|error| format!("reset worker lock marker: {error}"))?;
        file.rewind()
            .map_err(|error| format!("rewind worker lock marker: {error}"))?;
        writeln!(file, "{}", std::process::id())
            .map_err(|error| format!("write worker owner lock: {error}"))?;
        Ok(Self(file))
    }
}

fn app_support_dir() -> Result<PathBuf, String> {
    if std::env::var("SNDMAIL_WORKER_FIXTURE").ok().as_deref() == Some("1") {
        if let Some(path) = std::env::var_os("SNDMAIL_WORKER_DATA_DIR") {
            return Ok(PathBuf::from(path));
        }
    }
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "HOME is not set; cannot locate sndmail worker state".to_string())?;
    #[cfg(target_os = "macos")]
    let base = home.join("Library/Application Support");
    #[cfg(target_os = "linux")]
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".local/share"));
    #[cfg(target_os = "windows")]
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join("AppData/Roaming"));
    Ok(base.join("com.anydaysomething.sndmail"))
}

pub async fn run() -> Result<(), String> {
    let _owner = OwnerLock::acquire()?;
    let (mail_events, _) = broadcast::channel(64);
    let context = WorkerContext {
        shutdown: CancellationToken::new(),
        mail_changed: Arc::new(Notify::new()),
        relay_changed: Arc::new(Notify::new()),
        mail_events,
        mail_ready: Arc::new(AtomicBool::new(false)),
    };
    let listener = api::bind(&context.socket_path()?)?;

    tokio::select! {
        result = mail::run(&context) => result,
        result = api::run(listener, context.clone()) => result,
        signal = shutdown_signal() => {
            signal?;
            context.shutdown.cancel();
            Ok(())
        }
    }
}

async fn shutdown_signal() -> Result<(), String> {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut terminate = signal(SignalKind::terminate())
            .map_err(|error| format!("register SIGTERM handler: {error}"))?;
        tokio::select! {
            result = tokio::signal::ctrl_c() => result.map_err(|error| format!("wait for interrupt: {error}")),
            _ = terminate.recv() => Ok(()),
        }
    }
    #[cfg(not(unix))]
    {
        tokio::signal::ctrl_c()
            .await
            .map_err(|error| format!("wait for shutdown: {error}"))
    }
}
