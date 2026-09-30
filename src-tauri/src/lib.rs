#[cfg(not(target_os = "linux"))]
use tauri::{
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconId},
};
use tauri::{Emitter, Manager};
use tauri_plugin_autostart::MacosLauncher;

mod commands;
mod files;
mod imap;
mod keychain;
mod links;
mod net;
mod notifications;
mod oauth;
mod semantic_search;
mod smtp;
#[path = "worker/login.rs"]
mod worker_login;
#[path = "worker/profiles.rs"]
mod worker_profiles;

#[cfg(target_os = "macos")]
fn worker_socket_path() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME").map(std::path::PathBuf::from)
        .map(|home| home.join("Library/Application Support/com.anydaysomething.sndmail/worker.sock"))
}

#[tauri::command]
fn worker_disable() -> Result<(), String> {
    worker_login::uninstall()
}

#[tauri::command]
fn worker_create_relay_profile(
    profile_id: String,
    account_ids: Vec<String>,
    read_content: bool,
) -> Result<String, String> {
    worker_profiles::create_profile(&profile_id, account_ids, read_content)
}

#[tauri::command]
fn worker_revoke_relay_profile(profile_id: String) -> Result<(), String> {
    worker_profiles::revoke_profile(&profile_id)
}

#[tauri::command]
fn worker_wake() -> Result<(), String> {
    worker_send_control("wake")
}

#[tauri::command]
fn worker_reconfigure_relay() -> Result<(), String> {
    worker_send_control("relay_reconfigure")
}

fn worker_send_control(op: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use std::io::Write;
        let path = worker_socket_path().ok_or("HOME is not set")?;
        let mut stream = std::os::unix::net::UnixStream::connect(path)
            .map_err(|error| format!("connect to mail worker: {error}"))?;
        stream.set_write_timeout(Some(std::time::Duration::from_millis(500)))
            .map_err(|error| error.to_string())?;
        let request = format!("{{\"op\":{}}}\n", serde_json::to_string(op).map_err(|error| error.to_string())?);
        stream.write_all(request.as_bytes())
            .map_err(|error| format!("send worker control request: {error}"))?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    { let _ = op; Err("background mail worker is available on macOS only".into()) }
}

#[tauri::command]
fn worker_ensure_installed(app: tauri::AppHandle) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let executable = app.path().resource_dir()
            .map_err(|error| format!("find sndmail bundle resources: {error}"))?
            // Tauri maps the helper app bundle to Contents/Helpers so launchd
            // starts it with its own NSBundle identity for notifications.
            .join("../Helpers/SndmailWorker.app/Contents/MacOS/sndmail-worker");
        if !executable.is_file() {
            // A development build may attach to an already installed helper
            // from the user's app. Never start a second sync owner there.
            return worker_dev_install_status(worker_is_registered(), worker_is_running());
        }
        use std::io::Read;
        let mut magic = [0u8; 4];
        std::fs::File::open(&executable)
            .and_then(|mut file| file.read_exact(&mut magic))
            .map_err(|error| format!("read bundled mail worker: {error}"))?;
        let valid_macho = magic == [0xca, 0xfe, 0xba, 0xbe]
            || magic == [0xcf, 0xfa, 0xed, 0xfe];
        if !valid_macho {
            return Err("Bundled mail worker is not a compiled macOS executable".into());
        }
        let protocol = std::process::Command::new(&executable)
            .arg("--protocol-version")
            .output()
            .map_err(|error| format!("run bundled mail worker: {error}"))?;
        if !protocol.status.success() || protocol.stdout != b"sndmail-worker-protocol-1\n" {
            return Err("Bundled mail worker has an incompatible protocol version".into());
        }
        worker_login::install(&executable)?;
        Ok(true)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(false)
    }
}

fn worker_dev_install_status(registered: bool, running: bool) -> Result<bool, String> {
    if running {
        return Ok(true);
    }
    if registered {
        return Err(
            "The background mail helper is registered but not running. Open the installed sndmail app to restart it, or disable Background mail helper in Settings > General and relaunch.".into(),
        );
    }
    Ok(false)
}

#[tauri::command]
fn worker_is_ready() -> bool {
    #[cfg(target_os = "macos")]
    {
        use std::io::{BufRead, Write};
        use std::os::unix::net::UnixStream;
        let Some(path) = worker_socket_path() else { return false };
        let Ok(mut stream) = UnixStream::connect(path) else { return false };
        let _ = stream.set_read_timeout(Some(std::time::Duration::from_millis(500)));
        let _ = stream.set_write_timeout(Some(std::time::Duration::from_millis(500)));
        if stream.write_all(b"{\"op\":\"health\"}\n").is_err() { return false; }
        let mut response = String::new();
        let mut reader = std::io::BufReader::new(stream);
        if reader.read_line(&mut response).is_err() { return false; }
        serde_json::from_str::<serde_json::Value>(&response).ok()
            .is_some_and(|value| value.get("ok").and_then(|v| v.as_bool()) == Some(true)
                && value.pointer("/data/state").and_then(|v| v.as_str()) == Some("ready"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

#[tauri::command]
fn worker_is_running() -> bool {
    #[cfg(target_os = "macos")]
    {
        use std::os::fd::AsRawFd;
        let Some(path) = worker_socket_path().map(|path| path.with_file_name("worker.lock")) else { return false };
        let Ok(file) = std::fs::OpenOptions::new().read(true).write(true).create(true).open(path) else { return false };
        let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if rc == 0 { false } else { std::io::Error::last_os_error().raw_os_error() == Some(libc::EWOULDBLOCK) }
    }
    #[cfg(not(target_os = "macos"))]
    { false }
}

#[tauri::command]
fn worker_is_registered() -> bool {
    #[cfg(target_os = "macos")]
    {
        std::env::var_os("HOME").map(std::path::PathBuf::from)
            .is_some_and(|home| home.join("Library/LaunchAgents/com.anydaysomething.sndmail.worker.plist").exists())
    }
    #[cfg(not(target_os = "macos"))]
    { false }
}

#[tauri::command]
fn close_splashscreen(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("splashscreen") {
        let _ = w.close();
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[tauri::command]
fn set_tray_tooltip(app: tauri::AppHandle, tooltip: String) -> Result<(), String> {
    #[cfg(not(target_os = "linux"))]
    {
        let tray = app
            .tray_by_id(&TrayIconId::new("main-tray"))
            .ok_or_else(|| "Tray icon not found".to_string())?;
        tray.set_tooltip(Some(&tooltip)).map_err(|e| e.to_string())
    }
    #[cfg(target_os = "linux")]
    {
        let _ = tooltip;
        let _ = app;
        log::debug!("set_tray_tooltip is not supported on Linux (KSNI tray)");
        Ok(())
    }
}

#[tauri::command]
fn open_devtools(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        w.open_devtools();
    }
}

/// Data directory names used by earlier branded builds, newest first.
const LEGACY_IDENTIFIERS: [&str; 2] = ["com.anydaysomething.velopro", "com.velomail.app"];

/// Carry the data directory over to the new bundle identifier.
///
/// Tauri names the application-support directory after the identifier, so
/// renaming the app pointed it at an empty one: the database, the attachment
/// cache and every account with it would have looked simply gone. This runs
/// before the SQL plugin opens anything, and it is a rename rather than a
/// copy — the same volume, so it costs nothing however large the mailbox is.
///
/// An older empty bootstrap directory can coexist with a populated mailbox.
/// Keep it in place and move the unique populated store. Ambiguous populated
/// stores still require the user to resolve the conflict.
fn migrate_data_root(root: &std::path::Path, identifier: &str) -> Result<(), String> {
    let target = root.join(identifier);
    let sources: Vec<_> = LEGACY_IDENTIFIERS
        .iter()
        .map(|legacy| root.join(legacy))
        .filter(|path| path.is_dir())
        .collect();
    if sources.is_empty() {
        return Ok(());
    }
    let populated: Vec<_> = sources.iter().filter(|source| legacy_has_mail(source)).collect();
    if target.exists() && populated.is_empty() {
        return Ok(());
    }
    if populated.is_empty() && sources.len() != 1 {
        // With no mailbox, neither of several old settings stores can be
        // chosen safely. Retain all of them instead of guessing.
        return Ok(());
    }
    if target.exists() {
        return Err(format!(
            "Both sndmail data ({}) and legacy data ({}) exist. No data was moved; resolve the two folders before starting sndmail.",
            target.display(),
            populated.iter().map(|path| path.display().to_string()).collect::<Vec<_>>().join(", ")
        ));
    }
    if populated.len() > 1 {
        return Err(format!(
            "Multiple legacy data folders exist ({}). No data was moved; resolve the folders before starting sndmail.",
            populated.iter().map(|path| path.display().to_string()).collect::<Vec<_>>().join(", ")
        ));
    }
    let source = populated.first().copied().unwrap_or(&sources[0]);
    #[cfg(target_os = "macos")]
    for filename in ["velo.db", "velo.db-wal", "velo.db-shm"] {
        ensure_file_closed(&source.join(filename))?;
    }
    std::fs::rename(source, &target).map_err(|error| {
        format!(
            "Could not move legacy data from {} to {}: {error}. No source data was removed.",
            source.display(),
            target.display()
        )
    })?;
    log::info!("Moved {} to {}", source.display(), target.display());
    Ok(())
}

/// Keep a legacy plaintext key available to the worker under the canonical
/// filename, without consuming the old copy or replacing any current key.
/// The keychain remains the primary key source; this is only a lossless file
/// fallback migration for installs whose keychain already has a key.
fn canonicalize_legacy_key_file(data_dir: &std::path::Path) -> Result<(), String> {
    let legacy = data_dir.join("velo.key");
    let canonical = data_dir.join("sndmail.key");
    if !legacy.exists() || canonical.exists() {
        return Ok(());
    }
    let contents = std::fs::read(&legacy)
        .map_err(|error| format!("read legacy encryption key {}: {error}", legacy.display()))?;
    if contents.is_empty() {
        return Ok(());
    }
    static NEXT_TEMP: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let mut temp_file = None;
    let mut temp_path = None;
    for _ in 0..8 {
        let nonce = NEXT_TEMP.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let candidate = data_dir.join(format!(
            ".sndmail.key.migrating-{}-{nonce}",
            std::process::id()
        ));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&candidate) {
            Ok(file) => {
                temp_file = Some(file);
                temp_path = Some(candidate);
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("create temporary encryption key copy: {error}")),
        }
    }
    let (Some(mut file), Some(temp)) = (temp_file, temp_path) else {
        return Err("could not allocate a temporary encryption key copy".into());
    };
    use std::io::Write;
    if let Err(error) = file.write_all(&contents).and_then(|()| file.sync_all()) {
        drop(file);
        let _ = std::fs::remove_file(&temp);
        return Err(format!("write temporary encryption key copy: {error}"));
    }
    drop(file);
    // Hard-link publication is atomic and fails rather than replacing a key
    // another process published first. A crash cannot leave a partial target.
    match std::fs::hard_link(&temp, &canonical) {
        Ok(()) => {
            let _ = std::fs::remove_file(&temp);
            #[cfg(unix)]
            std::fs::File::open(data_dir)
                .and_then(|directory| directory.sync_all())
                .map_err(|error| format!("sync encryption key directory: {error}"))?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let _ = std::fs::remove_file(&temp);
        }
        Err(error) => {
            let _ = std::fs::remove_file(&temp);
            return Err(format!(
                "publish canonical encryption key {}: {error}",
                canonical.display()
            ));
        }
    }
    Ok(())
}

fn legacy_has_mail(source: &std::path::Path) -> bool {
    let database = source.join("velo.db");
    if !database.exists() { return false; }
    #[cfg(target_os = "macos")]
    {
        // Read the live WAL too. If a database is malformed or from an unknown
        // schema, treat it as populated and refuse to guess at its contents.
        let sql = "SELECT (SELECT count(*) FROM accounts) + (SELECT count(*) FROM messages) + (SELECT count(*) FROM threads);";
        let output = std::process::Command::new("/usr/bin/sqlite3")
            .arg("-readonly").arg(&database)
            .arg(sql)
            .output();
        if let Ok(output) = output {
            if output.status.success() {
                if let Ok(count) = String::from_utf8_lossy(&output.stdout).trim().parse::<u64>() {
                    return count > 0;
                }
            }
        }
        // SQLite's read-only CLI cannot open a WAL-mode database when its
        // -shm file is absent, even if the WAL itself is absent. The older
        // bootstrap store on this migration path has exactly that shape.
        // Immutable mode is safe only when there is no WAL to skip.
        if !source.join("velo.db-wal").exists() {
            if let Some(path) = database.to_str() {
                let uri_path = path.replace('%', "%25").replace('?', "%3F").replace('#', "%23");
                let uri = format!("file:{uri_path}?immutable=1");
                if let Ok(output) = std::process::Command::new("/usr/bin/sqlite3")
                    .arg(uri).arg(sql).output() {
                    if output.status.success() {
                        if let Ok(count) = String::from_utf8_lossy(&output.stdout).trim().parse::<u64>() {
                            return count > 0;
                        }
                    }
                }
            }
        }
    }
    true
}

fn migrate_legacy_data_dir(identifier: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let roots = {
        let Some(home) = std::env::var_os("HOME").map(std::path::PathBuf::from) else { return Ok(()) };
        [home.join("Library/Application Support")]
    };
    #[cfg(target_os = "linux")]
    let roots = {
        let Some(home) = std::env::var_os("HOME").map(std::path::PathBuf::from) else { return Ok(()) };
        [home.join(".local/share"), home.join(".config")]
    };
    #[cfg(target_os = "windows")]
    let roots = {
        let Some(appdata) = std::env::var_os("APPDATA").map(std::path::PathBuf::from) else { return Ok(()) };
        let local = std::env::var_os("LOCALAPPDATA")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| appdata.clone());
        [appdata, local]
    };

    for root in roots {
        migrate_data_root(&root, identifier)?;
        canonicalize_legacy_key_file(&root.join(identifier))?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn ensure_file_closed(path: &std::path::Path) -> Result<(), String> {
    if !path.exists() { return Ok(()); }
    let output = std::process::Command::new("/usr/sbin/lsof")
        .arg("-t").arg(path)
        .output().map_err(|error| format!("cannot check for an open legacy database: {error}"))?;
    if output.status.success() && !output.stdout.is_empty() {
        return Err(format!("A legacy process still has {} open; quit it before migrating", path.display()));
    }
    if output.status.code() != Some(1) && !output.status.success() {
        return Err(format!("Could not verify that {} is closed; sndmail left it untouched", path.display()));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn migration_lock() -> Result<std::fs::File, String> {
    use std::os::fd::AsRawFd;
    let home = std::env::var_os("HOME").ok_or("HOME is not set")?;
    let base = std::path::PathBuf::from(home).join("Library/Application Support");
    std::fs::create_dir_all(&base).map_err(|error| format!("create Application Support: {error}"))?;
    let file = std::fs::OpenOptions::new().read(true).write(true).create(true)
        .open(base.join(".sndmail-migration.lock"))
        .map_err(|error| format!("open migration lock: {error}"))?;
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err("Another sndmail instance is migrating mail data; wait for it to finish".into());
    }
    Ok(file)
}

#[cfg(target_os = "macos")]
fn sqlite_healthy(path: &std::path::Path) -> Result<bool, String> {
    let output = std::process::Command::new("/usr/bin/sqlite3")
        .arg(path).arg("PRAGMA quick_check;")
        .output().map_err(|error| format!("check migrated database: {error}"))?;
    Ok(output.status.success() && String::from_utf8_lossy(&output.stdout).trim() == "ok")
}

#[cfg(target_os = "macos")]
fn retire_legacy_autostart() -> Result<(), String> {
    let home = std::env::var_os("HOME").ok_or("HOME is not set")?;
    let agents = std::path::PathBuf::from(home).join("Library/LaunchAgents");
    let path = agents.join("Velo Pro.plist");
    if !path.is_file() { return Ok(()); }
    let contents = std::fs::read_to_string(&path)
        .map_err(|error| format!("read old Velo login item: {error}"))?;
    if !contents.contains("<string>Velo Pro</string>") || !contents.contains("Velo Pro.app") {
        return Err("An existing Velo Pro.plist does not match sndmail's legacy login item; left it untouched".into());
    }
    let domain = format!("gui/{}", unsafe { libc::geteuid() });
    let _ = std::process::Command::new("launchctl")
        .arg("bootout").arg(&domain).arg(&path).status();
    std::fs::remove_file(&path)
        .map_err(|error| format!("remove old Velo login item: {error}"))?;
    Ok(())
}

/// Migrate the database filename with its SQLite write-ahead sidecars.
/// This runs before the SQL plugin can create an empty database under the new
/// name. A collision or live old writer stops startup without touching mail.
fn migrate_database_filename(data_dir: &std::path::Path) -> Result<(), String> {
    let old = data_dir.join("velo.db");
    let new = data_dir.join("sndmail.db");
    let marker = data_dir.join(".sndmail-db-migrated");
    if !old.exists() {
        return Ok(());
    }
    if new.exists() {
        if marker.exists() {
            #[cfg(target_os = "macos")]
            if sqlite_healthy(&new)? { return Ok(()); }
            return Err(format!("Migrated database {} failed SQLite validation", new.display()));
        }
        return Err(format!("Both {} and {} exist; sndmail left them untouched", old.display(), new.display()));
    }
    #[cfg(target_os = "macos")]
    {
        for filename in ["velo.db", "velo.db-wal", "velo.db-shm"] {
            ensure_file_closed(&data_dir.join(filename))?;
        }
        let temp = data_dir.join("sndmail.db.migrating");
        if temp.exists() {
            std::fs::remove_file(&temp).map_err(|error| format!("remove interrupted database snapshot: {error}"))?;
        }
        let escaped = temp.to_string_lossy().replace('\'', "''");
        let output = std::process::Command::new("/usr/bin/sqlite3")
            .arg(&old).arg(format!("VACUUM INTO '{escaped}';"))
            .output().map_err(|error| format!("snapshot legacy database: {error}"))?;
        if !output.status.success() {
            return Err(format!("Could not snapshot legacy database: {}", String::from_utf8_lossy(&output.stderr).trim()));
        }
        if !sqlite_healthy(&temp)? {
            return Err("Migrated database snapshot failed SQLite validation".into());
        }
        // The marker is written before the atomic rename so a crash between
        // rename and marker creation is recoverable on the next launch.
        std::fs::write(&marker, b"database snapshot completed\n")
            .map_err(|error| format!("write database migration marker: {error}"))?;
        std::fs::rename(&temp, &new)
            .map_err(|error| format!("publish migrated database snapshot: {error}"))?;
        return Ok(());
    }
    #[cfg(not(target_os = "macos"))]
    { Err("automatic database filename migration is currently supported on macOS only".into()) }
}

#[cfg(target_os = "macos")]
fn report_startup_migration_error(error: &str) {
    eprintln!("sndmail could not safely migrate its mail data: {error}");
    // No webview exists yet. Make a migration refusal visible in a packaged
    // desktop launch instead of leaving the user staring at an app that quit.
    let escaped = error.replace('\\', "\\\\").replace('"', "\\\"");
    let message = format!("display alert \"sndmail needs your attention\" message \"{escaped}\" as critical");
    let _ = std::process::Command::new("/usr/bin/osascript")
        .arg("-e").arg(message).status();
}

#[cfg(test)]
mod data_migration_tests {
    use super::{migrate_data_root, worker_dev_install_status, LEGACY_IDENTIFIERS};
    use std::path::PathBuf;

    struct TestRoot(PathBuf);

    impl TestRoot {
        fn new() -> Self {
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "sndmail-data-migration-{}-{nonce}",
                std::process::id()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    #[test]
    fn development_worker_requires_a_live_owner_or_no_registration() {
        assert_eq!(worker_dev_install_status(false, false).unwrap(), false);
        assert_eq!(worker_dev_install_status(false, true).unwrap(), true);
        assert_eq!(worker_dev_install_status(true, true).unwrap(), true);
        let error = worker_dev_install_status(true, false).unwrap_err();
        assert!(error.contains("registered but not running"));
    }

    #[test]
    fn canonicalizes_legacy_key_without_consuming_it_when_keychain_is_already_used() {
        let root = TestRoot::new();
        // A current keychain entry does not make the legacy file safe to
        // discard: it remains a rollback/fallback source for older installs.
        let legacy_key = b"existing-encryption-key-from-velo";
        std::fs::write(root.0.join("velo.key"), legacy_key).unwrap();

        super::canonicalize_legacy_key_file(&root.0).unwrap();

        assert_eq!(std::fs::read(root.0.join("sndmail.key")).unwrap(), legacy_key);
        assert_eq!(std::fs::read(root.0.join("velo.key")).unwrap(), legacy_key);
        super::canonicalize_legacy_key_file(&root.0).unwrap();
        assert_eq!(std::fs::read(root.0.join("sndmail.key")).unwrap(), legacy_key);
        assert_eq!(std::fs::read(root.0.join("velo.key")).unwrap(), legacy_key);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(root.0.join("sndmail.key"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[test]
    fn key_filename_collision_preserves_both_values_without_overwrite() {
        let root = TestRoot::new();
        let legacy_key = b"legacy-encryption-key";
        let canonical_key = b"current-canonical-key";
        std::fs::write(root.0.join("velo.key"), legacy_key).unwrap();
        std::fs::write(root.0.join("sndmail.key"), canonical_key).unwrap();

        super::canonicalize_legacy_key_file(&root.0).unwrap();

        assert_eq!(std::fs::read(root.0.join("sndmail.key")).unwrap(), canonical_key);
        assert_eq!(std::fs::read(root.0.join("velo.key")).unwrap(), legacy_key);
    }

    #[test]
    fn interrupted_temporary_copy_is_ignored_and_complete_copy_is_published() {
        let root = TestRoot::new();
        let legacy_key = b"complete-legacy-encryption-key";
        let interrupted = root.0.join(".sndmail.key.migrating-interrupted");
        std::fs::write(&interrupted, b"partial").unwrap();
        std::fs::write(root.0.join("velo.key"), legacy_key).unwrap();

        super::canonicalize_legacy_key_file(&root.0).unwrap();

        assert_eq!(std::fs::read(root.0.join("sndmail.key")).unwrap(), legacy_key);
        assert_eq!(std::fs::read(root.0.join("velo.key")).unwrap(), legacy_key);
        // An orphaned temp from a crash is not mistaken for the published key.
        assert_eq!(std::fs::read(interrupted).unwrap(), b"partial");
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn moves_one_legacy_store_and_is_idempotent() {
        let root = TestRoot::new();
        let legacy = root.0.join(LEGACY_IDENTIFIERS[0]);
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join("velo.db"), b"existing account database").unwrap();

        migrate_data_root(&root.0, "com.anydaysomething.sndmail").unwrap();

        assert!(!legacy.exists());
        assert_eq!(
            std::fs::read(root.0.join("com.anydaysomething.sndmail/velo.db")).unwrap(),
            b"existing account database"
        );
        migrate_data_root(&root.0, "com.anydaysomething.sndmail").unwrap();
    }

    #[test]
    fn preserves_both_stores_and_errors_on_collision() {
        let root = TestRoot::new();
        let legacy = root.0.join(LEGACY_IDENTIFIERS[0]);
        let current = root.0.join("com.anydaysomething.sndmail");
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::create_dir_all(&current).unwrap();
        std::fs::write(legacy.join("velo.db"), b"legacy database").unwrap();
        std::fs::write(current.join("sndmail.db"), b"current database").unwrap();

        assert!(migrate_data_root(&root.0, "com.anydaysomething.sndmail").is_err());
        assert_eq!(std::fs::read(legacy.join("velo.db")).unwrap(), b"legacy database");
        assert_eq!(std::fs::read(current.join("sndmail.db")).unwrap(), b"current database");
    }

    #[test]
    fn refuses_multiple_legacy_stores_without_moving_either() {
        let root = TestRoot::new();
        let newest = root.0.join(LEGACY_IDENTIFIERS[0]);
        let oldest = root.0.join(LEGACY_IDENTIFIERS[1]);
        std::fs::create_dir_all(&newest).unwrap();
        std::fs::create_dir_all(&oldest).unwrap();
        std::fs::write(newest.join("velo.db"), b"new mailbox").unwrap();
        std::fs::write(oldest.join("velo.db"), b"other mailbox").unwrap();

        assert!(migrate_data_root(&root.0, "com.anydaysomething.sndmail").is_err());
        assert!(newest.exists());
        assert!(oldest.exists());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn chooses_unique_populated_mailbox_over_empty_bootstrap_store() {
        let root = TestRoot::new();
        let populated = root.0.join(LEGACY_IDENTIFIERS[0]);
        let empty = root.0.join(LEGACY_IDENTIFIERS[1]);
        std::fs::create_dir_all(&populated).unwrap();
        std::fs::create_dir_all(&empty).unwrap();
        for directory in [&populated, &empty] {
            let status = std::process::Command::new("/usr/bin/sqlite3")
                .arg(directory.join("velo.db"))
                .arg("PRAGMA journal_mode=WAL; CREATE TABLE accounts(id TEXT); CREATE TABLE messages(id TEXT); CREATE TABLE threads(id TEXT);")
                .status().unwrap();
            assert!(status.success());
        }
        let status = std::process::Command::new("/usr/bin/sqlite3")
            .arg(populated.join("velo.db"))
            .arg("INSERT INTO accounts VALUES ('account');")
            .status().unwrap();
        assert!(status.success());
        migrate_data_root(&root.0, "com.anydaysomething.sndmail").unwrap();
        assert!(empty.join("velo.db").exists());
        assert!(root.0.join("com.anydaysomething.sndmail/velo.db").exists());
        assert!(!populated.exists());
        // The retained empty store must not block the next launch.
        migrate_data_root(&root.0, "com.anydaysomething.sndmail").unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn database_snapshot_keeps_accounts_and_legacy_source() {
        let root = TestRoot::new();
        let legacy = root.0.join("velo.db");
        let setup = std::process::Command::new("/usr/bin/sqlite3")
            .arg(&legacy)
            .arg("CREATE TABLE accounts(id TEXT PRIMARY KEY, email TEXT); INSERT INTO accounts VALUES ('a', 'user@example.test');")
            .status().unwrap();
        assert!(setup.success());

        super::migrate_database_filename(&root.0).unwrap();
        super::migrate_database_filename(&root.0).unwrap();
        assert!(legacy.exists());
        let output = std::process::Command::new("/usr/bin/sqlite3")
            .arg(root.0.join("sndmail.db"))
            .arg("SELECT email FROM accounts WHERE id='a';")
            .output().unwrap();
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "user@example.test");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn database_collision_without_marker_preserves_both_files() {
        let root = TestRoot::new();
        std::fs::write(root.0.join("velo.db"), b"old").unwrap();
        std::fs::write(root.0.join("sndmail.db"), b"new").unwrap();
        assert!(super::migrate_database_filename(&root.0).is_err());
        assert_eq!(std::fs::read(root.0.join("velo.db")).unwrap(), b"old");
        assert_eq!(std::fs::read(root.0.join("sndmail.db")).unwrap(), b"new");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn refuses_to_move_data_root_while_old_database_is_open() {
        use std::io::Write;
        use std::process::{Command, Stdio};
        let root = TestRoot::new();
        let legacy_dir = root.0.join(LEGACY_IDENTIFIERS[0]);
        std::fs::create_dir_all(&legacy_dir).unwrap();
        let database = legacy_dir.join("velo.db");
        let mut child = Command::new("/usr/bin/sqlite3")
            .arg(&database)
            .stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null())
            .spawn().unwrap();
        child.stdin.as_mut().unwrap().write_all(b"CREATE TABLE keep_me(id INTEGER);\nBEGIN IMMEDIATE;\n").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(200));
        assert!(migrate_data_root(&root.0, "com.anydaysomething.sndmail").is_err());
        assert!(legacy_dir.exists());
        assert!(!root.0.join("com.anydaysomething.sndmail").exists());
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    {
    #[cfg(target_os = "macos")]
    let _migration_guard = match migration_lock() {
        Ok(lock) => lock,
        Err(error) => { report_startup_migration_error(&error); return; }
    };
    // Before any plugin opens a file under it
    if let Err(error) = migrate_legacy_data_dir("com.anydaysomething.sndmail") {
        #[cfg(target_os = "macos")]
        report_startup_migration_error(&error);
        #[cfg(not(target_os = "macos"))]
        eprintln!("sndmail could not safely migrate its existing data: {error}");
        return;
    }
    #[cfg(target_os = "macos")]
    if let Some(home) = std::env::var_os("HOME") {
        let data_dir = std::path::PathBuf::from(home)
            .join("Library/Application Support/com.anydaysomething.sndmail");
        if let Err(error) = migrate_database_filename(&data_dir) {
            report_startup_migration_error(&error);
            return;
        }
    }
    #[cfg(target_os = "macos")]
    if let Err(error) = retire_legacy_autostart() {
        report_startup_migration_error(&error);
        return;
    }
    } // Release the migration lock before entering Tauri's event loop.

    // And before any window exists: this one can put a system dialog on
    // screen, which must not end up behind the always-on-top splash
    keychain::migrate_legacy_key();

    // Set explicit AUMID on Windows so toast notifications show "sndmail"
    // instead of "Windows PowerShell"
    #[cfg(windows)]
    {
        use windows::core::w;
        use windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
        unsafe {
            let _ = SetCurrentProcessExplicitAppUserModelID(w!("com.anydaysomething.sndmail"));
        }
    }

    tauri::Builder::default()
        // Single instance MUST be first
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
                let _ = window.unminimize();
            }
            // Forward args for deep linking
            let _ = app.emit("single-instance-args", argv);
        }))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        // Writing a one-time code to the clipboard has to work while the app is
        // in the background, which the webview's own clipboard API cannot do
        .plugin(tauri_plugin_clipboard_manager::init())
        // Sandboxed message frames cannot execute click listeners in WebKit.
        // Own their navigations natively and return them to the trusted UI.
        .plugin(links::init())
        // One IDLE watcher per account, held so a restart can replace rather
        // than duplicate them
        .manage(std::sync::Arc::new(crate::imap::idle::IdleRegistry::new()))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_os::init())
        .invoke_handler(tauri::generate_handler![
            oauth::start_oauth_server,
            oauth::oauth_exchange_token,
            oauth::oauth_refresh_token,
            keychain::keychain_get_key,
            keychain::keychain_set_key,
            keychain::keychain_delete_key,
            keychain::keychain_available,
            net::unsubscribe_one_click,
            files::save_attachment,
            files::quicklook_attachment,
            set_tray_tooltip,
            close_splashscreen,
            open_devtools,
            worker_ensure_installed,
            worker_is_ready,
            worker_is_running,
            worker_is_registered,
            worker_disable,
            worker_create_relay_profile,
            worker_revoke_relay_profile,
            worker_wake,
            worker_reconfigure_relay,
            semantic_search::semantic_search_status,
            semantic_search::semantic_search_set_enabled,
            semantic_search::semantic_search_download_model,
            semantic_search::semantic_search_reindex,
            notifications::notification_native_available,
            notifications::notification_native_request_permission,
            notifications::notification_native_register_categories,
            notifications::notification_native_show,
            notifications::notification_native_ready,
            commands::imap_start_idle,
            commands::imap_stop_idle,
            commands::imap_stop_all_idle,
            commands::imap_test_connection,
            commands::imap_list_folders,
            commands::imap_fetch_messages,
            commands::imap_fetch_new_uids,
            commands::imap_search_all_uids,
            commands::imap_fetch_message_body,
            commands::imap_fetch_raw_message,
            commands::imap_set_flags,
            commands::imap_move_messages,
            commands::imap_delete_messages,
            commands::imap_get_folder_status,
            commands::imap_fetch_attachment,
            commands::imap_append_message,
            commands::imap_search_folder,
            commands::imap_sync_folder,
            commands::imap_raw_fetch_diagnostic,
            commands::imap_delta_check,
            commands::smtp_send_email,
            commands::smtp_test_connection,
        ])
        .setup(|app| {
            {
                let level = if cfg!(debug_assertions) {
                    log::LevelFilter::Debug
                } else {
                    log::LevelFilter::Info
                };
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(level)
                        .level_for("sqlx::query", log::LevelFilter::Warn)
                        .build(),
                )?;
            }

            // Before the app finishes launching: a notification click that
            // starts Velo is delivered to whatever delegate exists by then
            notifications::install(app.handle().clone());
            semantic_search::install(app.handle());

            #[cfg(not(target_os = "linux"))]
            {
                // Build system tray menu
                let show = MenuItem::with_id(app, "show", "Show Velo", true, None::<&str>)?;
                let check_mail =
                    MenuItem::with_id(app, "check_mail", "Check for Mail", true, None::<&str>)?;
                let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&show, &check_mail, &quit])?;

                let icon = app
                    .default_window_icon()
                    .cloned()
                    .expect("app should have a default icon configured in tauri.conf.json bundle");

                TrayIconBuilder::with_id("main-tray")
                    .icon(icon)
                    .tooltip("Velo Pro")
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "check_mail" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.emit("tray-check-mail", ());
                            }
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let tauri::tray::TrayIconEvent::DoubleClick { .. } = event {
                            let app = tray.app_handle();
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    })
                    .build(app)?;
            }

            #[cfg(target_os = "linux")]
            {
                use tray_item::{IconSource, TrayItem};

                let app_handle = app.handle().clone();

                std::thread::spawn(move || {
                    let mut tray = match TrayItem::new("Velo Pro", IconSource::Resource("mail-read")) {
                        Ok(t) => t,
                        Err(e) => {
                            log::warn!("Failed to create system tray: {e}");
                            return;
                        }
                    };

                    let app_handle_show = app_handle.clone();
                    if let Err(e) = tray.add_menu_item("Show Velo", move || {
                        if let Some(window) = app_handle_show.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }) {
                        log::warn!("Failed to add tray menu item 'Show Velo': {e}");
                    }

                    let app_handle_check = app_handle.clone();
                    if let Err(e) = tray.add_menu_item("Check for Mail", move || {
                        if let Some(window) = app_handle_check.get_webview_window("main") {
                            let _ = window.emit("tray-check-mail", ());
                        }
                    }) {
                        log::warn!("Failed to add tray menu item 'Check for Mail': {e}");
                    }

                    let app_handle_quit = app_handle.clone();
                    if let Err(e) = tray.add_menu_item("Quit", move || {
                        app_handle_quit.exit(0);
                    }) {
                        log::warn!("Failed to add tray menu item 'Quit': {e}");
                    }

                    loop {
                        std::thread::park();
                    }
                });
            }

            // On Windows/Linux, remove decorations for custom titlebar.
            // macOS uses titleBarStyle: "overlay" from config instead, which
            // preserves native event routing in WKWebView.
            #[cfg(not(target_os = "macos"))]
            {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_decorations(false);
                }
            }

            // Start hidden in tray if launched with --hidden (autostart)
            if std::env::args().any(|a| a == "--hidden") {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
                // Also close splash screen when starting hidden
                if let Some(splash) = app.get_webview_window("splashscreen") {
                    let _ = splash.close();
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            // Minimize to tray on close instead of quitting (main window only)
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                if let Some(manager) = app.try_state::<std::sync::Arc<semantic_search::SemanticSearchManager>>() {
                    manager.shutdown();
                }
            }
        });

    log::info!("Tauri application exited normally");
}
