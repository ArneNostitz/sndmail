use std::path::{Path, PathBuf};

const LABEL: &str = "com.anydaysomething.sndmail.worker";

/// Install the helper as a per-user macOS LaunchAgent and start it now.
/// `executable` must be the signed helper bundled with the installed app.
#[cfg(target_os = "macos")]
pub fn install(executable: &Path) -> Result<PathBuf, String> {
    use std::fs;
    use std::process::Command;

    if !executable.is_file() {
        return Err(format!(
            "background worker executable is missing: {}",
            executable.display()
        ));
    }
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "HOME is not set; cannot install the login item".to_string())?;
    let directory = home.join("Library/LaunchAgents");
    fs::create_dir_all(&directory)
        .map_err(|error| format!("create LaunchAgents directory: {error}"))?;
    let plist = directory.join(format!("{LABEL}.plist"));
    let temp = directory.join(format!(".{LABEL}.{}.tmp", std::process::id()));
    let xml = launch_agent_plist(executable);
    let domain = launchctl_domain()?;
    if fs::read_to_string(&plist).ok().as_deref() == Some(xml.as_str()) {
        // A matching file does not prove launchd loaded it: the service may
        // have been manually booted out or an earlier bootstrap may have
        // failed. Preserve a running process, but repair the unloaded case.
        if service_is_loaded(&domain) {
            return Ok(plist);
        }
        run_launchctl(&["enable", &format!("{domain}/{LABEL}")])?;
        run_launchctl(&["bootstrap", &domain, plist.to_str().ok_or("invalid plist path")?])?;
        return Ok(plist);
    }
    fs::write(&temp, xml).map_err(|error| format!("write LaunchAgent plist: {error}"))?;
    fs::rename(&temp, &plist).map_err(|error| format!("install LaunchAgent plist: {error}"))?;

    let _ = Command::new("launchctl")
        .args([
            "bootout",
            &domain,
            plist.to_str().ok_or("invalid plist path")?,
        ])
        .status();
    run_launchctl(&["enable", &format!("{domain}/{LABEL}")])?;
    run_launchctl(&[
        "bootstrap",
        &domain,
        plist.to_str().ok_or("invalid plist path")?,
    ])?;
    Ok(plist)
}

#[cfg(target_os = "macos")]
fn service_is_loaded(domain: &str) -> bool {
    std::process::Command::new("launchctl")
        .args(["print", &format!("{domain}/{LABEL}")])
        .output()
        .is_ok_and(|output| output.status.success())
}

/// Remove the per-user login item and unload its current instance.
#[cfg(target_os = "macos")]
pub fn uninstall() -> Result<(), String> {
    use std::fs;
    use std::process::Command;

    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "HOME is not set; cannot remove the login item".to_string())?;
    let plist = home
        .join("Library/LaunchAgents")
        .join(format!("{LABEL}.plist"));
    let domain = launchctl_domain()?;
    // A not-loaded service is a normal state during removal.
    let _ = Command::new("launchctl")
        .args(["bootout", &format!("{domain}/{LABEL}")])
        .status();
    if plist.exists() {
        fs::remove_file(plist).map_err(|error| format!("remove LaunchAgent plist: {error}"))?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn launchctl_domain() -> Result<String, String> {
    let uid = unsafe { libc::geteuid() };
    Ok(format!("gui/{uid}"))
}

#[cfg(target_os = "macos")]
fn run_launchctl(args: &[&str]) -> Result<(), String> {
    let output = std::process::Command::new("launchctl")
        .args(args)
        .output()
        .map_err(|error| format!("run launchctl {}: {error}", args.join(" ")))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "launchctl {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

#[cfg(target_os = "macos")]
fn launch_agent_plist(executable: &Path) -> String {
    let executable = xml_escape(&executable.to_string_lossy());
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>{executable}</string><string>--background-worker</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>/dev/null</string>
</dict>
</plist>
"#
    )
}

#[cfg(target_os = "macos")]
fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// This launch item is a macOS feature. Other platforms report it clearly.
#[cfg(not(target_os = "macos"))]
pub fn install(_executable: &Path) -> Result<PathBuf, String> {
    Err(
        "automatic background worker login registration is currently supported on macOS only"
            .into(),
    )
}

#[cfg(not(target_os = "macos"))]
pub fn uninstall() -> Result<(), String> {
    Err(
        "automatic background worker login registration is currently supported on macOS only"
            .into(),
    )
}
