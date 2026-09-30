//! OS keychain storage for the database encryption key.
//!
//! The key is stored in the platform credential store:
//!   - macOS/iOS  : Keychain Services
//!   - Windows    : Credential Manager
//!   - Linux/BSD  : Secret Service (GNOME Keyring, KWallet, ...)
//!
//! If no credential store is available (e.g. a headless Linux box with no
//! Secret Service provider), the commands return an error and the frontend
//! falls back to the sndmail file-based key so the app stays usable.

use keyring::Entry;

const SERVICE: &str = "com.anydaysomething.sndmail";
const ACCOUNT: &str = "db-encryption-key";

fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, ACCOUNT).map_err(|e| format!("Keychain unavailable: {e}"))
}

/// Read the encryption key from the OS credential store.
/// Returns `Ok(None)` when no key has been stored yet (a normal first launch),
/// and `Err` only when the credential store itself cannot be reached.
#[tauri::command]
pub fn keychain_get_key() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
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
