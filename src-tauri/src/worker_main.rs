//! Entry point for the mail worker, which runs without the Tauri webview.

#[cfg(target_os = "macos")]
#[path = "imap/mod.rs"]
mod imap;
#[cfg(target_os = "macos")]
mod worker;

#[cfg(target_os = "macos")]
fn main() {
    if std::env::args().any(|arg| arg == "--protocol-version") {
        println!("sndmail-worker-protocol-1");
        return;
    }
    if std::env::args().any(|arg| arg == "--bundle-info") {
        use objc2_foundation::NSBundle;
        let bundle = NSBundle::mainBundle();
        println!("bundle_path={}", bundle.bundlePath());
        println!("bundle_id={}", bundle.bundleIdentifier().map(|id| id.to_string()).unwrap_or_default());
        return;
    }
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy};

    let main_thread = MainThreadMarker::new().expect("worker main thread marker unavailable");
    let application = NSApplication::sharedApplication(main_thread);
    let _ = application.setActivationPolicy(NSApplicationActivationPolicy::Prohibited);
    std::thread::Builder::new().name("sndmail-worker-runtime".into()).spawn(move || {
        let result = tokio::runtime::Builder::new_current_thread().enable_all().build()
            .map_err(|error| format!("worker runtime: {error}"))
            .and_then(|runtime| runtime.block_on(worker::run()));
        if let Err(error) = result {
            eprintln!("sndmail worker stopped: {error}");
            std::process::exit(1);
        }
        std::process::exit(0);
    }).expect("cannot start worker runtime");
    application.run();
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("The sndmail background worker is currently supported on macOS only");
    std::process::exit(1);
}
