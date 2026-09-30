//! OS keychain storage for the database encryption key.
//!
//! Replaces the previous plaintext `velo.key` file in the app data directory.
//! The key is stored in the platform credential store:
//!   - macOS/iOS  : Keychain Services
//!   - Windows    : Credential Manager
//!   - Linux/BSD  : Secret Service (GNOME Keyring, KWallet, ...)
//!
//! If no credential store is available (e.g. a headless Linux box with no
//! Secret Service provider), the commands return an error and the frontend
//! falls back to the legacy file-based key so the app stays usable.

use keyring::Entry;

const SERVICE: &str = "com.anydaysomething.sndmail";
const ACCOUNT: &str = "db-encryption-key";

/// Credential services used by earlier app identities. Keep reading these
/// until all installations have carried their database key forward.
const LEGACY_SERVICES: [&str; 2] = ["com.anydaysomething.velopro", "com.velomail.app"];

fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, ACCOUNT).map_err(|e| format!("Keychain unavailable: {e}"))
}

fn legacy_entry(service: &str) -> Result<Entry, String> {
    Entry::new(service, ACCOUNT).map_err(|e| format!("Keychain unavailable: {e}"))
}

/// Copy the key out of the pre-rename entry, before any window exists.
///
/// Reading a keychain item written by a differently-signed binary makes macOS
/// ask the user first. Done lazily — on the frontend's first decrypt — that
/// question arrives while the splash screen is up, and the splash is
/// `alwaysOnTop`: the dialog can end up behind it, with nothing to click and
/// an app that never finishes starting. Asking here, before Tauri builds a
/// single window, puts the dialog in front of the user where it belongs.
///
/// Best-effort throughout: a refusal or a missing credential store leaves the
/// lazy path in `keychain_get_key` to try again and report properly.
pub fn migrate_legacy_key() {
    let Ok(current) = entry() else {
        return;
    };
    if current.get_password().is_ok() {
        return; // already carried over, or this install never had the old name
    }
    for service in LEGACY_SERVICES {
        let Ok(legacy) = legacy_entry(service) else { continue };
        match legacy.get_password() {
            Ok(secret) => {
                match current.set_password(&secret) {
                    Ok(()) => log::info!("Carried the database encryption key over to {SERVICE}"),
                    Err(e) => log::warn!("Could not store the encryption key under {SERVICE}: {e}"),
                }
                return;
            }
            Err(keyring::Error::NoEntry) => {}
            Err(e) => log::warn!("Could not read the encryption key under {service}: {e}"),
        }
    }
}

/// Read the encryption key from the OS credential store.
/// Returns `Ok(None)` when no key has been stored yet (a normal first launch),
/// and `Err` only when the credential store itself cannot be reached.
#[tauri::command]
pub fn keychain_get_key() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        // Nothing under the current name: the key may still be filed under the
        // one the app had before it was renamed. Copy it across rather than
        // read it every time, and leave the old entry alone — an older build
        // pointed at the same database must keep working.
        Err(keyring::Error::NoEntry) => {
            for service in LEGACY_SERVICES {
                match legacy_entry(service)?.get_password() {
                    Ok(secret) => {
                        if let Err(e) = entry()?.set_password(&secret) {
                            log::warn!("Could not copy the encryption key to the new keychain entry: {e}");
                        }
                        return Ok(Some(secret));
                    }
                    Err(keyring::Error::NoEntry) => {}
                    Err(e) => return Err(format!("Failed to read key from keychain: {e}")),
                }
            }
            Ok(None)
        }
        Err(e) => Err(format!("Failed to read key from keychain: {e}")),
    }
}

/// Write the encryption key to the OS credential store, replacing any existing value.
#[tauri::command]
pub fn keychain_set_key(key: String) -> Result<(), String> {
    if key.is_empty() {
        return Err("Refusing to store an empty encryption key".to_string());
    }
    entry()?
        .set_password(&key)
        .map_err(|e| format!("Failed to write key to keychain: {e}"))
}

/// Remove the stored key. Used only when resetting the app.
#[tauri::command]
pub fn keychain_delete_key() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Failed to delete key from keychain: {e}")),
    }
}

/// Whether a working credential store is present on this machine.
#[tauri::command]
pub fn keychain_available() -> bool {
    match Entry::new(SERVICE, ACCOUNT) {
        Ok(e) => !matches!(
            e.get_password(),
            Err(keyring::Error::PlatformFailure(_)) | Err(keyring::Error::NoStorageAccess(_))
        ),
        Err(_) => false,
    }
}
