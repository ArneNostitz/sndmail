//! Local Commonplace capability profiles. Secrets are returned once and only
//! their SHA-256 digests are kept in the owner-only profile file.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use base64::Engine;
use serde::{Deserialize, Serialize};

const PROFILE_FILE: &str = "worker-profiles.json";
const MAX_PROFILES: usize = 64;
const MAX_ACCOUNTS_PER_PROFILE: usize = 128;
const MAX_PROFILE_FILE_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct Profile {
    pub(crate) profile_id: String,
    token_sha256: String,
    pub(crate) account_ids: Vec<String>,
    pub(crate) scopes: Vec<String>,
}

/// Secret-free view of a stored grant — safe to hand to the frontend.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSummary {
    pub profile_id: String,
    pub account_ids: Vec<String>,
    pub scopes: Vec<String>,
}

pub(crate) fn load_profiles() -> Result<Vec<Profile>, String> {
    let path = profile_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    ensure_private_file(&path)?;
    let metadata =
        fs::metadata(&path).map_err(|error| format!("inspect worker profiles: {error}"))?;
    if metadata.len() > MAX_PROFILE_FILE_BYTES {
        return Err("worker profile file exceeds size limit".into());
    }
    let bytes = fs::read(path).map_err(|error| format!("read worker profiles: {error}"))?;
    let profiles: Vec<Profile> =
        serde_json::from_slice(&bytes).map_err(|_| "worker profile file is invalid".to_string())?;
    if profiles.len() > MAX_PROFILES
        || profiles.iter().any(|profile| {
            validate_profile_id(&profile.profile_id).is_err()
                || profile.token_sha256.len() != 64
                || profile
                    .token_sha256
                    .bytes()
                    .any(|byte| !byte.is_ascii_hexdigit())
                || profile.account_ids.is_empty()
                || profile.account_ids.len() > MAX_ACCOUNTS_PER_PROFILE
                || profile.account_ids.iter().any(|id| {
                    id.is_empty()
                        || id.len() > 256
                        || id.bytes().any(|byte| byte.is_ascii_control())
                })
                || !profile.scopes.contains(&"metadata".to_string())
                || profile
                    .scopes
                    .iter()
                    .any(|scope| scope != "metadata" && scope != "read_content")
        })
    {
        return Err("worker profile file contains an invalid profile".into());
    }
    Ok(profiles)
}

/// Create or replace one explicit Commonplace grant and return its bearer
/// secret once. The grant always includes metadata and can optionally include
/// raw message content.
pub fn create_profile(
    profile_id: &str,
    account_ids: Vec<String>,
    read_content: bool,
) -> Result<String, String> {
    validate_profile_id(profile_id)?;
    let account_ids = normalize_account_ids(account_ids)?;
    if account_ids.is_empty() {
        return Err("select at least one mail account for this profile".into());
    }
    let mut profiles = load_profiles()?;
    if !profiles
        .iter()
        .any(|profile| profile.profile_id == profile_id)
        && profiles.len() >= MAX_PROFILES
    {
        return Err("too many worker profiles".into());
    }
    let token = create_token()?;
    let mut scopes = vec!["metadata".to_string()];
    if read_content {
        scopes.push("read_content".into());
    }
    let profile = Profile {
        profile_id: profile_id.to_string(),
        token_sha256: digest_token(&token),
        account_ids,
        scopes,
    };
    profiles.retain(|old| old.profile_id != profile_id);
    profiles.push(profile);
    save_profiles(&profiles)?;
    Ok(token)
}

/// Revoke a profile and its existing token immediately.
pub fn revoke_profile(profile_id: &str) -> Result<(), String> {
    validate_profile_id(profile_id)?;
    let mut profiles = load_profiles()?;
    profiles.retain(|profile| profile.profile_id != profile_id);
    save_profiles(&profiles)
}

/// Secret-free list of stored grants, for settings UIs that show which
/// accounts a share currently covers.
pub fn list_profiles() -> Result<Vec<ProfileSummary>, String> {
    Ok(load_profiles()?
        .into_iter()
        .map(|profile| ProfileSummary {
            profile_id: profile.profile_id,
            account_ids: profile.account_ids,
            scopes: profile.scopes,
        })
        .collect())
}

/// Change which accounts a profile grants without rotating its token.
/// Clearing the list leaves the profile without any account to grant, so it
/// is revoked like an explicit `revoke_profile`.
pub fn update_profile_accounts(
    profile_id: &str,
    account_ids: Vec<String>,
) -> Result<(), String> {
    validate_profile_id(profile_id)?;
    let account_ids = normalize_account_ids(account_ids)?;
    if account_ids.is_empty() {
        return revoke_profile(profile_id);
    }
    let mut profiles = load_profiles()?;
    let profile = profiles
        .iter_mut()
        .find(|profile| profile.profile_id == profile_id)
        .ok_or_else(|| "no such worker profile".to_string())?;
    profile.account_ids = account_ids;
    save_profiles(&profiles)
}

impl Profile {
    pub(crate) fn allows_account(&self, account_id: &str) -> bool {
        self.account_ids.iter().any(|allowed| allowed == account_id)
    }

    pub(crate) fn has_scope(&self, scope: &str) -> bool {
        self.scopes.iter().any(|granted| granted == scope)
    }

    pub(crate) fn verify_token(&self, token: &str) -> bool {
        let supplied = digest_token(token);
        constant_time_eq(self.token_sha256.as_bytes(), supplied.as_bytes())
    }

    #[cfg(test)]
    pub(crate) fn fixture(profile_id: &str, token: &str, account_ids: &[&str]) -> Self {
        Self {
            profile_id: profile_id.to_string(),
            token_sha256: digest_token(token),
            account_ids: account_ids.iter().map(|id| (*id).to_string()).collect(),
            scopes: vec!["metadata".into()],
        }
    }
}

fn profile_path() -> Result<PathBuf, String> {
    if std::env::var("SNDMAIL_WORKER_FIXTURE").ok().as_deref() == Some("1") {
        if let Some(directory) = std::env::var_os("SNDMAIL_WORKER_DATA_DIR").map(PathBuf::from) {
            fs::create_dir_all(&directory)
                .map_err(|error| format!("create fixture worker directory: {error}"))?;
            set_private_directory(&directory)?;
            return Ok(directory.join(PROFILE_FILE));
        }
    }
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "HOME is not set; cannot locate worker profiles".to_string())?;
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
    let directory = base.join("com.anydaysomething.sndmail");
    fs::create_dir_all(&directory)
        .map_err(|error| format!("create worker data directory: {error}"))?;
    set_private_directory(&directory)?;
    Ok(directory.join(PROFILE_FILE))
}

fn save_profiles(profiles: &[Profile]) -> Result<(), String> {
    if profiles.len() > MAX_PROFILES {
        return Err("too many worker profiles".into());
    }
    let path = profile_path()?;
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| format!("clock is before Unix epoch: {error}"))?
        .as_nanos();
    let temp = path.with_extension(format!("{}.{}.tmp", std::process::id(), nonce));
    let data = serde_json::to_vec(profiles).map_err(|error| error.to_string())?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temp)
        .map_err(|error| format!("create worker profile file: {error}"))?;
    if let Err(error) = file.write_all(&data).and_then(|_| file.sync_all()) {
        let _ = fs::remove_file(&temp);
        return Err(format!("write worker profile file: {error}"));
    }
    fs::rename(&temp, &path).map_err(|error| {
        let _ = fs::remove_file(&temp);
        format!("install worker profile file: {error}")
    })?;
    ensure_private_file(&path)
}

fn ensure_private_file(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let metadata =
            fs::metadata(path).map_err(|error| format!("inspect worker profile file: {error}"))?;
        if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
            return Err("worker profile file must be owned by this user with mode 0600".into());
        }
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("restrict worker profile file: {error}"))?;
    }
    Ok(())
}

fn set_private_directory(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let metadata = fs::metadata(path)
            .map_err(|error| format!("inspect worker data directory: {error}"))?;
        if metadata.uid() != unsafe { libc::geteuid() } {
            return Err("worker data directory is owned by another user".into());
        }
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("restrict worker data directory: {error}"))?;
    }
    Ok(())
}

fn create_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|error| format!("generate profile token: {error}"))?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes))
}

fn digest_token(token: &str) -> String {
    let digest = ring::digest::digest(&ring::digest::SHA256, token.as_bytes());
    digest
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0u8, |difference, (a, b)| difference | (a ^ b))
        == 0
}

fn validate_profile_id(profile_id: &str) -> Result<(), String> {
    if profile_id.is_empty()
        || profile_id.len() > 100
        || !profile_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("profile_id must be 1-100 ASCII letters, digits, '-' or '_'".into());
    }
    Ok(())
}

fn normalize_account_ids(mut account_ids: Vec<String>) -> Result<Vec<String>, String> {
    if account_ids.len() > MAX_ACCOUNTS_PER_PROFILE {
        return Err("too many accounts selected for this profile".into());
    }
    if account_ids
        .iter()
        .any(|id| id.is_empty() || id.len() > 256 || id.bytes().any(|byte| byte.is_ascii_control()))
    {
        return Err("profile contains an invalid account ID".into());
    }
    account_ids.sort();
    account_ids.dedup();
    Ok(account_ids)
}

/// Serializes tests that set the process-global worker fixture env vars.
/// Held by the crypto test in `worker::mail` too — parallel tests would
/// otherwise point each other at a temp dir that gets deleted.
#[cfg(test)]
pub(crate) static FIXTURE_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;

    fn with_fixture_profile_dir<T>(run: impl FnOnce(&std::path::Path) -> T) -> T {
        let _guard = FIXTURE_ENV_LOCK.lock().unwrap_or_else(|poison| poison.into_inner());
        let dir = std::env::temp_dir().join(format!(
            "sndmail-worker-profiles-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let old_fixture = std::env::var_os("SNDMAIL_WORKER_FIXTURE");
        let old_data = std::env::var_os("SNDMAIL_WORKER_DATA_DIR");
        std::env::set_var("SNDMAIL_WORKER_FIXTURE", "1");
        std::env::set_var("SNDMAIL_WORKER_DATA_DIR", &dir);
        let result = run(&dir);
        let _ = fs::remove_dir_all(&dir);
        if let Some(value) = old_fixture {
            std::env::set_var("SNDMAIL_WORKER_FIXTURE", value);
        } else {
            std::env::remove_var("SNDMAIL_WORKER_FIXTURE");
        }
        if let Some(value) = old_data {
            std::env::set_var("SNDMAIL_WORKER_DATA_DIR", value);
        } else {
            std::env::remove_var("SNDMAIL_WORKER_DATA_DIR");
        }
        result
    }

    // One test: the fixture directory is process-global env state.
    #[test]
    fn update_profile_accounts_edits_grants_without_rotating_the_token() {
        with_fixture_profile_dir(|_| {
            let token = create_profile("commonplace", vec!["a1".into()], true).unwrap();
            update_profile_accounts("commonplace", vec!["a2".into(), "a1".into()]).unwrap();
            let profiles = load_profiles().unwrap();
            let profile = &profiles[0];
            assert_eq!(profile.account_ids, vec!["a1".to_string(), "a2".to_string()]);
            assert!(profile.verify_token(&token));
            let summary = list_profiles().unwrap();
            assert_eq!(summary[0].profile_id, "commonplace");
            assert_eq!(summary[0].account_ids, vec!["a1".to_string(), "a2".to_string()]);
            assert_eq!(
                summary[0].scopes,
                vec!["metadata".to_string(), "read_content".to_string()]
            );

            assert!(update_profile_accounts("missing", vec!["a1".into()]).is_err());

            update_profile_accounts("commonplace", Vec::new()).unwrap();
            assert!(load_profiles().unwrap().is_empty());
        });
    }
}
