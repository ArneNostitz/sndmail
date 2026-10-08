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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
            semantic_search::semantic_search_query,
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
            // starts sndmail is delivered to whatever delegate exists by then
            notifications::install(app.handle().clone());
            semantic_search::install(app.handle());

            #[cfg(not(target_os = "linux"))]
            {
                // Build system tray menu
                let show = MenuItem::with_id(app, "show", "Show sndmail", true, None::<&str>)?;
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
                    .tooltip("sndmail")
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
                    let mut tray = match TrayItem::new("sndmail", IconSource::Resource("mail-read")) {
                        Ok(t) => t,
                        Err(e) => {
                            log::warn!("Failed to create system tray: {e}");
                            return;
                        }
                    };

                    let app_handle_show = app_handle.clone();
                    if let Err(e) = tray.add_menu_item("Show sndmail", move || {
                        if let Some(window) = app_handle_show.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }) {
                        log::warn!("Failed to add tray menu item 'Show sndmail': {e}");
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
