//! Credentials at rest, in the format the frontend uses.
//!
//! The app (`src/utils/crypto.ts`) writes `iv:ciphertext` AES-256-GCM values
//! keyed by the OS credential store entry, falling back to `sndmail.key` in the
//! app data directory when no credential store is reachable. Both the app
//! process and the background worker read and write the same rows, so the key
//! resolution and the wire format live here once, in a module both binaries
//! compile.
//!
//! Nothing in this module logs or returns plaintext credentials except to its
//! caller.

use base64::Engine;
use ring::aead::{self, Aad, LessSafeKey, Nonce, UnboundKey};

const KEYCHAIN_SERVICE: &str = "com.anydaysomething.sndmail";
const KEYCHAIN_ACCOUNT: &str = "db-encryption-key";

/// Serialises tests that mutate the process-global fixture environment.
#[cfg(test)]
pub(crate) static FIXTURE_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn fixture_mode() -> bool {
    std::env::var("SNDMAIL_WORKER_FIXTURE").as_deref() == Ok("1")
}

/// The directory holding `sndmail.db` and the fallback key file.
///
/// Fixtures point this at a temporary directory so a test run never touches the
/// signed-in user's real mail store or key.
pub(crate) fn app_data_dir() -> Result<std::path::PathBuf, String> {
    if fixture_mode() {
        if let Some(path) = std::env::var_os("SNDMAIL_WORKER_DATA_DIR") {
            return Ok(std::path::PathBuf::from(path));
        }
    }
    let home = std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .ok_or_else(|| "HOME is not set; cannot locate the sndmail data directory".to_string())?;
    #[cfg(target_os = "macos")]
    let base = home.join("Library/Application Support");
    #[cfg(target_os = "linux")]
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| home.join(".local/share"));
    #[cfg(target_os = "windows")]
    let base = std::env::var_os("APPDATA")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| home.join("AppData/Roaming"));
    Ok(base.join(KEYCHAIN_SERVICE))
}

/// Resolve the base64 AES key shared with `src/utils/crypto.ts`.
///
/// Fixtures never read the user's real keychain, even when the test process
/// runs under the same login session.
pub(crate) fn encryption_key() -> Result<Vec<u8>, String> {
    let stored = if fixture_mode() {
        None
    } else {
        keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
            .ok()
            .and_then(|entry| entry.get_password().ok())
    };
    let encoded = if let Some(stored) = stored {
        stored
    } else {
        // Use only sndmail's canonical fallback file. Never create a new key
        // here: a wrong key would make existing credentials appear corrupt.
        let directory = app_data_dir()?;
        std::fs::read_to_string(directory.join("sndmail.key"))
            .map_err(|_| "encryption key unavailable".to_string())?
    };
    base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .map_err(|_| "invalid encryption key".to_string())
}

/// Decrypt a stored value, passing through anything that is not in the
/// encrypted format (older rows were stored as plaintext).
///
/// The app process only writes credentials; the worker reads them. Both
/// binaries compile this module, so it is dead code in the app build.
#[allow(dead_code)]
pub(crate) fn decrypt(value: &str) -> Result<String, String> {
    let Some((iv, ciphertext)) = value.split_once(':') else {
        return Ok(value.to_owned());
    };
    let decoder = base64::engine::general_purpose::STANDARD;
    let Ok(iv) = decoder.decode(iv) else {
        return Ok(value.to_owned());
    };
    if iv.len() != 12 {
        return Ok(value.to_owned());
    }
    let mut ciphertext = decoder
        .decode(ciphertext)
        .map_err(|_| "invalid encrypted credential".to_string())?;
    let key = encryption_key()?;
    let unbound = UnboundKey::new(&aead::AES_256_GCM, &key)
        .map_err(|_| "invalid encryption key".to_string())?;
    let nonce = Nonce::try_assume_unique_for_key(&iv)
        .map_err(|_| "invalid encrypted credential".to_string())?;
    let plaintext = LessSafeKey::new(unbound)
        .open_in_place(nonce, Aad::empty(), &mut ciphertext)
        .map_err(|_| "cannot decrypt account credential".to_string())?;
    String::from_utf8(plaintext.to_vec()).map_err(|_| "invalid credential encoding".to_string())
}

/// Encrypt a credential in the same `iv:ciphertext` format the frontend writes.
pub(crate) fn encrypt(value: &str) -> Result<String, String> {
    let key = encryption_key()?;
    let unbound = UnboundKey::new(&aead::AES_256_GCM, &key)
        .map_err(|_| "invalid encryption key".to_string())?;
    let mut iv = [0u8; 12];
    getrandom::getrandom(&mut iv).map_err(|_| "cannot generate credential nonce".to_string())?;
    let nonce = Nonce::assume_unique_for_key(iv);
    let mut bytes = value.as_bytes().to_vec();
    LessSafeKey::new(unbound)
        .seal_in_place_append_tag(nonce, Aad::empty(), &mut bytes)
        .map_err(|_| "cannot encrypt credential".to_string())?;
    let encoder = base64::engine::general_purpose::STANDARD;
    Ok(format!("{}:{}", encoder.encode(iv), encoder.encode(bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        directory: std::path::PathBuf,
        old_fixture: Option<std::ffi::OsString>,
        old_data: Option<std::ffi::OsString>,
    }

    impl Fixture {
        fn install() -> Self {
            let directory =
                std::env::temp_dir().join(format!("sndmail-credentials-{}", std::process::id()));
            std::fs::create_dir_all(&directory).unwrap();
            let old_fixture = std::env::var_os("SNDMAIL_WORKER_FIXTURE");
            let old_data = std::env::var_os("SNDMAIL_WORKER_DATA_DIR");
            std::env::set_var("SNDMAIL_WORKER_FIXTURE", "1");
            std::env::set_var("SNDMAIL_WORKER_DATA_DIR", &directory);
            Self { directory, old_fixture, old_data }
        }

        fn write_key(&self, byte: u8) {
            let key = base64::engine::general_purpose::STANDARD.encode([byte; 32]);
            std::fs::write(self.directory.join("sndmail.key"), key).unwrap();
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.directory);
            match self.old_fixture.take() {
                Some(value) => std::env::set_var("SNDMAIL_WORKER_FIXTURE", value),
                None => std::env::remove_var("SNDMAIL_WORKER_FIXTURE"),
            }
            match self.old_data.take() {
                Some(value) => std::env::set_var("SNDMAIL_WORKER_DATA_DIR", value),
                None => std::env::remove_var("SNDMAIL_WORKER_DATA_DIR"),
            }
        }
    }

    #[test]
    fn frontend_aes_gcm_credential_format_roundtrips_and_rejects_wrong_key() {
        // The env vars are process-global, so this takes the same lock the
        // other fixture tests do to avoid deleting each other's directories.
        let _guard = FIXTURE_ENV_LOCK
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let fixture = Fixture::install();
        fixture.write_key(23);
        let encoded = encrypt("refresh-token-μ").unwrap();
        let (iv, body) = encoded.split_once(':').unwrap();
        assert_eq!(
            base64::engine::general_purpose::STANDARD.decode(iv).unwrap().len(),
            12
        );
        assert!(
            base64::engine::general_purpose::STANDARD
                .decode(body)
                .unwrap()
                .len()
                > 16
        );
        assert_eq!(decrypt(&encoded).unwrap(), "refresh-token-μ");
        fixture.write_key(42);
        assert!(decrypt(&encoded).is_err());
    }

    #[test]
    fn plaintext_rows_pass_through_decrypt() {
        assert_eq!(decrypt("app-password").unwrap(), "app-password");
    }
}
