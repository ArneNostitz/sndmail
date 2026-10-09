//! sndmail-owned local semantic search, fully in-process. No servers, helper
//! processes, ports, remote mail upload, or credentials in IPC responses.
//! Keyword FTS stays the always-on base; this engine only adds meaning-based
//! matches. Settings poll Status.
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::Manager;
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

use sqlx::{
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
    SqlitePool,
};

use crate::semantic_documents::{build_passages, collect_messages, RawMessage};
use crate::semantic_embed::Embedder;
use crate::semantic_vectors::VectorStore;

const MODEL_ID: &str = "ts/multilingual-e5-small";
const MODEL_DIR: &str = "ts_multilingual-e5-small";
const MODEL_MD5: &str = "59cdc138465277af7094b9b7872c6b7a";
const TOKENIZER_MD5: &str = "5a903c8df2ed2e71ae185cd0393e1625";
const CANCELLED: &str = "Semantic search operation cancelled.";
// How long a loaded model stays in memory after the last use before it is
// dropped, keeping the idle footprint at zero. The next query reloads it.
const EMBEDDER_IDLE: Duration = Duration::from_secs(120);
const EMBEDDER_SWEEP: Duration = Duration::from_secs(30);

// model.onnx comes from the Typesense mirror set (the model identity is
// unchanged); tokenizer.json comes from the canonical intfloat repository.
const MODEL_ORIGIN: &str = "https://huggingface.co/typesense/models-moved/resolve/main/multilingual-e5-small";
const MODEL_ORIGIN_FALLBACK: &str = "https://models.typesense.org/public/multilingual-e5-small";
const TOKENIZER_ORIGIN: &str = "https://huggingface.co/intfloat/multilingual-e5-small/resolve/main";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    supported: bool,
    enabled: bool,
    // unsupported | disabled | model_required | downloading | starting |
    // indexing | ready | error
    state: String,
    // missing | downloading | ready | error
    model_state: String,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    indexed_documents: Option<u64>,
    message: Option<String>,
    data_path: String,
    model_id: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticEvidence {
    passage: String,
    title_context: Option<String>,
    distance: f64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearcherHit {
    id: String,
    title: String,
    #[serde(default)]
    subtitle: Option<String>,
    #[serde(default)]
    snippet: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    metadata: serde_json::Value,
    #[serde(default)]
    match_kind: Option<String>,
    #[serde(default)]
    relevance: Option<f64>,
    #[serde(default)]
    semantic_evidence: Option<SemanticEvidence>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    hits: Vec<SearcherHit>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    enabled: bool,
}

struct Inner {
    status: Status,
    config: Option<Config>,
    generation: u64,
    cancel: CancellationToken,
    closing: bool,
}

pub struct SemanticSearchManager {
    root: PathBuf,
    database: PathBuf,
    inner: Mutex<Inner>,
    // Loaded lazily on first use, dropped after EMBEDDER_IDLE so nothing stays
    // resident while the feature is idle.
    embedder: Mutex<Option<(Arc<Embedder>, Instant)>>,
    reaper_cancel: CancellationToken,
    // Serialize short mutations and model transfers, never an embedding pass
    // or query; those run on blocking threads and only touch the embedder slot.
    transition: Mutex<()>,
}

fn random_hex() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|_| "Cannot generate a private identifier.".to_string())?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn confirmed_absent(id: i32) -> bool {
    #[cfg(unix)]
    {
        // Signal 0 only probes existence. EPERM or any other uncertainty is
        // treated as live; persisted ownership never authorizes a signal.
        (unsafe { libc::kill(id, 0) == -1 })
            && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
    }
    #[cfg(not(unix))]
    { let _ = id; false }
}

fn private_dir(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|_| "Cannot create the private semantic search directory.".to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| "Cannot protect the semantic search directory.".to_string())?;
    }
    Ok(())
}

fn private_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("Invalid semantic search file path.")?;
    private_dir(parent)?;
    let temp = parent.join(format!(".sndmail-{}.tmp", random_hex()?));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp).map_err(|_| "Cannot create private search configuration.".to_string())?;
        file.write_all(bytes).and_then(|_| file.sync_all())
            .map_err(|_| "Cannot save private search configuration.".to_string())?;
        fs::rename(&temp, path).map_err(|_| "Cannot install private search configuration.".to_string())
    })();
    if result.is_err() { let _ = fs::remove_file(temp); }
    result
}

fn encode<T: Serialize>(value: &T) -> Result<Vec<u8>, String> {
    serde_json::to_vec(value).map_err(|_| "Cannot encode semantic search configuration.".to_string())
}

fn hash_file(path: &Path, token: &CancellationToken) -> Result<String, String> {
    let mut input = File::open(path).map_err(|_| "Model file is missing or unreadable.".to_string())?;
    let mut hash = md5::Context::new();
    let mut buffer = [0u8; 128 * 1024];
    loop {
        if token.is_cancelled() { return Err(CANCELLED.into()); }
        let size = input.read(&mut buffer).map_err(|_| "Cannot read the downloaded model.".to_string())?;
        if size == 0 { break; }
        hash.consume(&buffer[..size]);
    }
    Ok(format!("{:x}", hash.compute()))
}

fn cache_valid(path: &Path, token: &CancellationToken) -> bool {
    hash_file(&path.join("model.onnx"), token).is_ok_and(|hash| hash == MODEL_MD5)
        && hash_file(&path.join("tokenizer.json"), token).is_ok_and(|hash| hash == TOKENIZER_MD5)
}

fn file_valid(path: &Path, expected_md5: &str, token: &CancellationToken) -> bool {
    hash_file(path, token).is_ok_and(|hash| hash == expected_md5)
}

fn semantic_interval() -> Duration {
    let seconds = std::env::var("SNDMAIL_SEMANTIC_INTERVAL_SECONDS")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(300)
        .clamp(60, 3600);
    Duration::from_secs(seconds)
}

// One-time cleanup of the retired Typesense-era files inside the private
// root. Exact names only; a lock directory is only removed when its owning
// worker is confirmed dead, and an unknown marker is never touched.
fn clean_legacy(root: &Path, discovery: Option<&Path>) {
    if let Err(error) = recover_worker_lock(root) {
        log::warn!("semantic legacy worker lock kept: {}", error);
    }
    for name in ["db", "meta", "typesense.ini", "worker.json", "worker-owner.json", "searcher.json"] {
        let path = root.join(name);
        let removed = match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_dir() => fs::remove_dir_all(&path),
            Ok(_) => fs::remove_file(&path),
            Err(_) => Ok(()),
        };
        if let Err(error) = removed { log::warn!("semantic legacy file {} kept: {}", name, error); }
    }
    if let Some(path) = discovery {
        // Only our own discovery file is ever removed; anything else is left
        // untouched for whichever installation owns it.
        let ours = fs::read(path).ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            .is_some_and(|value| value["managedBy"] == "sndmail");
        if ours {
            if let Err(error) = fs::remove_file(path) { log::warn!("semantic discovery file kept: {}", error); }
        }
    }
}

fn recover_worker_lock(root: &Path) -> Result<(), String> {
    const BUSY: &str = "The managed mail indexer lock cannot be safely recovered. Another worker may still be running, or its ownership cannot be confirmed. sndmail left the lock untouched.";
    let directory = root.join("sndmail-worker-v1.lock");
    match fs::symlink_metadata(&directory) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Ok(metadata) if metadata.file_type().is_dir() => {},
        _ => return Err(BUSY.into()),
    }
    let ownership_path = root.join("worker-owner.json");
    let marker_path = directory.join("owner.json");
    for path in [&ownership_path, &marker_path] {
        let regular = fs::symlink_metadata(path)
            .is_ok_and(|metadata| metadata.file_type().is_file() && metadata.len() <= 4096);
        if !regular { return Err(BUSY.into()); }
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct WorkerOwnership { group_id: u32, owner_token: String }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct WorkerLockMarker { pid: u32, owner_token: String }
    let ownership: WorkerOwnership = serde_json::from_slice(
        &fs::read(&ownership_path).map_err(|_| BUSY.to_string())?
    ).map_err(|_| BUSY.to_string())?;
    let marker: WorkerLockMarker = serde_json::from_slice(
        &fs::read(&marker_path).map_err(|_| BUSY.to_string())?
    ).map_err(|_| BUSY.to_string())?;
    if ownership.owner_token.len() != 36 || marker.owner_token != ownership.owner_token
        || !(2..=i32::MAX as u32).contains(&ownership.group_id)
        || !(2..=i32::MAX as u32).contains(&marker.pid)
        || !confirmed_absent(-(ownership.group_id as i32))
        || !confirmed_absent(marker.pid as i32)
    {
        return Err(BUSY.into());
    }
    fs::remove_file(&marker_path).map_err(|_| "Cannot remove the confirmed stopped worker's lock marker.".to_string())?;
    fs::remove_dir(&directory).map_err(|_| "The managed worker lock directory contains other entries; sndmail preserved them.".to_string())?;
    Ok(())
}

impl SemanticSearchManager {
    fn new(app: &tauri::AppHandle) -> Self {
        let data = app.path().app_data_dir().ok();
        let root = data.as_ref().map(|p| p.join("semantic-search")).unwrap_or_default();
        let supported = cfg!(all(any(target_os = "macos", target_os = "linux"), any(target_arch = "aarch64", target_arch = "x86_64")))
            && data.is_some();
        #[cfg(target_os = "macos")]
        let discovery = app.path().home_dir().ok().map(|p| p.join("Library/Application Support/universal-search/sndmail-runtime.json"));
        #[cfg(not(target_os = "macos"))]
        let discovery: Option<PathBuf> = None;
        if supported {
            let _ = private_dir(&root);
            clean_legacy(&root, discovery.as_deref());
        }
        let mut status = Status {
            supported, enabled: false,
            state: if supported { "disabled" } else { "unsupported" }.into(),
            model_state: "missing".into(), downloaded_bytes: 0, total_bytes: None,
            indexed_documents: None,
            message: (!supported).then(|| "Local semantic search is unavailable on this platform.".into()),
            data_path: root.to_string_lossy().into_owned(), model_id: MODEL_ID.into(),
        };
        let mut config = None;
        if supported {
            let loaded = (|| {
                private_dir(&root)?;
                let path = root.join("config.json");
                // The old configuration carried an api_key for the retired
                // local server; unknown fields are ignored here and the file
                // is rewritten without it on the next change.
                let cfg: Config = match fs::read(&path) {
                    Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| "Private semantic search configuration is invalid. Restore config.json before retrying.".to_string())?,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Config { enabled: false },
                    Err(_) => return Err("Cannot read private semantic search configuration.".into()),
                };
                Ok::<_, String>(cfg)
            })();
            match loaded {
                Ok(cfg) => {
                    status.enabled = cfg.enabled;
                    if cfg.enabled { status.state = "model_required".into(); }
                    config = Some(cfg);
                }
                Err(error) => { status.state = "error".into(); status.message = Some(error); }
            }
        }
        Self {
            root,
            database: data.map(|p| p.join("sndmail.db")).unwrap_or_default(),
            inner: Mutex::new(Inner { status, config, generation: 0, cancel: CancellationToken::new(), closing: false }),
            embedder: Mutex::new(None),
            reaper_cancel: CancellationToken::new(),
            transition: Mutex::new(()),
        }
    }

    fn status(&self) -> Status { self.inner.lock().unwrap().status.clone() }

    fn current(inner: &Inner, generation: u64) -> bool {
        !inner.closing && inner.generation == generation && !inner.cancel.is_cancelled()
    }

    fn require(inner: &Inner) -> Result<(), String> {
        if inner.closing { return Err("sndmail is quitting.".into()); }
        if !inner.status.supported { return Err("Local semantic search is not supported on this platform.".into()); }
        if inner.config.is_none() { return Err("Private semantic search configuration is unavailable.".into()); }
        Ok(())
    }

    fn publish(&self, generation: u64, update: impl FnOnce(&mut Status)) {
        let mut inner = self.inner.lock().unwrap();
        if !Self::current(&inner, generation) { return; }
        update(&mut inner.status);
    }

    fn cancel(inner: &mut Inner) -> (u64, CancellationToken) {
        inner.cancel.cancel();
        inner.generation += 1;
        inner.cancel = CancellationToken::new();
        (inner.generation, inner.cancel.clone())
    }

    // Blocking: may load the model. Called only from blocking threads.
    fn embedder_handle(self: &Arc<Self>) -> Result<Arc<Embedder>, String> {
        let mut slot = self.embedder.lock().unwrap();
        if slot.is_none() {
            let embedder = Arc::new(Embedder::load(&self.root.join("models").join(MODEL_DIR))?);
            *slot = Some((embedder, Instant::now()));
        }
        let (embedder, last_used) = slot.as_mut().expect("embedder slot was just filled");
        *last_used = Instant::now();
        Ok(embedder.clone())
    }

    fn drop_embedder(&self) {
        *self.embedder.lock().unwrap() = None;
    }

    async fn read_database_pool(&self) -> Result<SqlitePool, String> {
        let options = SqliteConnectOptions::new()
            .filename(&self.database)
            .read_only(true)
            .create_if_missing(false)
            .busy_timeout(Duration::from_secs(5));
        SqlitePoolOptions::new().max_connections(1).connect_with(options).await
            .map_err(|_| "Cannot open the local mail database for semantic indexing.".into())
    }

    fn resume(self: &Arc<Self>) {
        let inner = self.inner.lock().unwrap();
        if inner.config.is_none() { return; }
        let generation = inner.generation;
        let token = inner.cancel.clone();
        drop(inner);
        self.verify_then_resume(generation, token);
    }

    fn verify_then_resume(self: &Arc<Self>, generation: u64, token: CancellationToken) {
        let manager = self.clone();
        tauri::async_runtime::spawn(async move {
            let path = manager.root.join("models").join(MODEL_DIR);
            let check_token = token.clone();
            let valid = tauri::async_runtime::spawn_blocking(move || cache_valid(&path, &check_token)).await.unwrap_or(false);
            if token.is_cancelled() { return; }
            manager.publish(generation, |s| {
                s.model_state = if valid { "ready" } else { "missing" }.into();
                s.state = if !s.enabled { "disabled" } else if valid { "starting" } else { "model_required" }.into();
                s.message = if s.enabled && !valid { Some("Download the multilingual model to enable local semantic search.".into()) } else { None };
            });
            if valid && manager.is_enabled(generation) { manager.run(generation, token).await; }
        });
    }

    fn is_enabled(&self, generation: u64) -> bool {
        let inner = self.inner.lock().unwrap();
        Self::current(&inner, generation) && inner.status.enabled
    }

    fn set_enabled(self: &Arc<Self>, enabled: bool) -> Result<Status, String> {
        let _transition = self.transition.lock().unwrap();
        let mut inner = self.inner.lock().unwrap();
        Self::require(&inner)?;
        if enabled && inner.status.enabled && matches!(inner.status.state.as_str(), "starting" | "indexing" | "ready" | "downloading") {
            return Ok(inner.status.clone());
        }
        let mut config = inner.config.clone().unwrap();
        config.enabled = enabled;
        // Failure to persist disabling must not leave the engine running.
        let saved = private_write(&self.root.join("config.json"), &encode(&config)?);
        if enabled { saved.as_ref().map_err(Clone::clone)?; }
        inner.config = Some(config);
        inner.status.enabled = enabled;
        if enabled && inner.status.model_state == "downloading" {
            return Ok(inner.status.clone());
        }
        let (generation, token) = Self::cancel(&mut inner);
        if inner.status.model_state == "downloading" {
            inner.status.model_state = "missing".into();
            inner.status.downloaded_bytes = 0;
            inner.status.total_bytes = None;
        }
        inner.status.state = if enabled {
            if inner.status.model_state == "ready" { "starting" } else { "model_required" }
        } else { "disabled" }.into();
        inner.status.message = None;
        self.drop_embedder();
        drop(inner);
        if let Err(error) = saved {
            let mut inner = self.inner.lock().unwrap();
            inner.status.state = "error".into();
            inner.status.message = Some(error.clone());
            return Err(error);
        }
        if enabled { self.verify_then_resume(generation, token); }
        Ok(self.status())
    }

    fn download_model(self: &Arc<Self>) -> Result<Status, String> {
        let _transition = self.transition.lock().unwrap();
        let mut inner = self.inner.lock().unwrap();
        Self::require(&inner)?;
        if matches!(inner.status.model_state.as_str(), "ready" | "downloading") { return Ok(inner.status.clone()); }
        let (generation, token) = Self::cancel(&mut inner);
        inner.status.model_state = "downloading".into();
        inner.status.state = "downloading".into();
        inner.status.downloaded_bytes = 0;
        inner.status.total_bytes = None;
        inner.status.message = Some("Downloading the multilingual model files (about 465 MiB in total; existing files are reused).".into());
        drop(inner);
        let manager = self.clone();
        tauri::async_runtime::spawn(async move { manager.download(generation, token).await; });
        Ok(self.status())
    }

    fn reindex(self: &Arc<Self>) -> Result<Status, String> {
        let _transition = self.transition.lock().unwrap();
        let mut inner = self.inner.lock().unwrap();
        Self::require(&inner)?;
        if !inner.status.enabled || inner.status.model_state != "ready" {
            return Err("Enable semantic search and finish downloading the model before reindexing.".into());
        }
        let (generation, token) = Self::cancel(&mut inner);
        inner.status.state = "indexing".into();
        inner.status.message = Some("Rebuilding the local mail index from scratch.".into());
        drop(inner);
        let manager = self.clone();
        tauri::async_runtime::spawn(async move {
            match VectorStore::open(&manager.root).await {
                Err(error) => { manager.fail(generation, error, false); }
                Ok(store) => {
                    if let Err(error) = store.clear().await { manager.fail(generation, error, false); return; }
                    manager.run(generation, token).await;
                }
            }
        });
        Ok(self.status())
    }

    async fn download(self: Arc<Self>, generation: u64, token: CancellationToken) {
        let destination = self.root.join("models").join(MODEL_DIR);
        let check_token = token.clone();
        let already_valid = tauri::async_runtime::spawn_blocking(move || cache_valid(&destination, &check_token)).await.unwrap_or(false);
        if already_valid && !token.is_cancelled() {
            self.publish(generation, |s| {
                s.model_state = "ready".into();
                s.state = if s.enabled { "starting" } else { "disabled" }.into();
                s.message = None;
            });
            if self.is_enabled(generation) { self.clone().run(generation, token).await; }
            return;
        }
        let stage = self.root.join("models").join(format!(".download-{}-{generation}", std::process::id()));
        let result = tokio::select! {
            biased;
            _ = token.cancelled() => Err(CANCELLED.to_string()),
            result = self.download_files(generation, &stage) => result,
        };
        if result.is_ok() && !token.is_cancelled() {
            let manager = self.clone();
            let stage_copy = stage.clone();
            let promoted = tauri::async_runtime::spawn_blocking(move || {
                let inner = manager.inner.lock().unwrap();
                if !Self::current(&inner, generation) { return Err(CANCELLED.into()); }
                // Only a verified, fully staged directory becomes the public cache.
                // A previous invalid cache is renamed out of the way, never exposed
                // as a partly updated model. A failed promotion restores it.
                let destination = manager.root.join("models").join(MODEL_DIR);
                let old = manager.root.join("models").join(format!(".replaced-{}-{generation}", std::process::id()));
                let had_old = destination.exists();
                if had_old { fs::rename(&destination, &old).map_err(|_| "Cannot replace the previous model cache.".to_string())?; }
                if fs::rename(&stage_copy, &destination).is_err() {
                    if had_old { let _ = fs::rename(&old, &destination); }
                    return Err("Cannot install the verified model cache.".to_string());
                }
                drop(inner);
                if had_old { let _ = fs::remove_dir_all(old); }
                Ok::<_, String>(())
            }).await.unwrap_or_else(|_| Err("Model installation task failed.".into()));
            if let Err(error) = promoted { self.fail_async(generation, error, true).await; }
            else {
                self.publish(generation, |s| {
                    s.model_state = "ready".into();
                    s.state = if s.enabled { "starting" } else { "disabled" }.into();
                    s.total_bytes = Some(s.downloaded_bytes);
                    s.message = None;
                });
                if self.is_enabled(generation) { self.clone().run(generation, token.clone()).await; }
            }
        } else if let Err(error) = result {
            if !token.is_cancelled() { self.fail_async(generation, error, true).await; }
        }
        let _ = tokio::fs::remove_dir_all(stage).await;
    }

    async fn download_files(&self, generation: u64, stage: &Path) -> Result<(), String> {
        tokio::fs::create_dir_all(stage).await.map_err(|_| "Cannot create model download staging directory.".to_string())?;
        let client = reqwest::Client::builder().https_only(true).no_proxy()
            .connect_timeout(Duration::from_secs(15))
            .build().map_err(|_| "Cannot initialize model downloads.".to_string())?;
        let destination = self.root.join("models").join(MODEL_DIR);
        #[derive(Clone, Copy)]
        struct ModelFile { name: &'static str, md5: &'static str, origins: [&'static str; 2], max_bytes: u64 }
        let files = [
            ModelFile { name: "model.onnx", md5: MODEL_MD5, origins: [MODEL_ORIGIN, MODEL_ORIGIN_FALLBACK], max_bytes: 600 * 1024 * 1024 },
            ModelFile { name: "tokenizer.json", md5: TOKENIZER_MD5, origins: [TOKENIZER_ORIGIN, TOKENIZER_ORIGIN], max_bytes: 32 * 1024 * 1024 },
        ];
        let mut plan = Vec::new();
        for file in &files {
            // Resume: an already-valid file is copied into the stage instead of
            // being downloaded again, so adding the tokenizer only fetches it.
            let source = destination.join(file.name);
            let expected = file.md5;
            let reusable = tauri::async_runtime::spawn_blocking(move || {
                let token = CancellationToken::new();
                file_valid(&source, expected, &token)
            }).await.unwrap_or(false);
            if reusable {
                let size = fs::metadata(&destination.join(file.name)).map_err(|_| "Cannot reuse the existing model file.".to_string())?.len();
                plan.push((*file, None, Some(size)));
            } else {
                plan.push((*file, Some(client.clone()), None));
            }
        }
        // Content-Length is optional; never substitute an estimate for measured bytes.
        let mut total = Some(0u64);
        let mut downloaded = 0u64;
        for (file, client_slot, local_size) in &plan {
            let length = match (client_slot, local_size) {
                (None, Some(size)) => Some(*size),
                (Some(client), None) => {
                    let mut resolved: Option<u64> = None;
                    for origin in file.origins {
                        let response = client.head(format!("{origin}/{}", file.name)).timeout(Duration::from_secs(15)).send().await;
                        if let Some(length) = response.ok().filter(|r| r.status().is_success()).and_then(|r| r.content_length()) {
                            resolved = Some(length);
                            break;
                        }
                    }
                    resolved
                }
                _ => None,
            };
            total = total.zip(length).and_then(|(a, b)| a.checked_add(b));
        }
        self.publish(generation, |s| s.total_bytes = total);
        for (file, client_slot, local_size) in &plan {
            match (client_slot, local_size) {
                (None, Some(_)) => {
                    // Reuse the verified local copy.
                    let size = fs::copy(destination.join(file.name), stage.join(file.name))
                        .map_err(|_| "Cannot reuse the existing model file.".to_string())?;
                    downloaded += size;
                    self.publish(generation, |s| {
                        s.downloaded_bytes = downloaded;
                        if s.total_bytes.is_some_and(|total| downloaded > total) { s.total_bytes = None; }
                    });
                }
                (Some(client), None) => {
                    // The outer download cancellation select also covers the
                    // header deadline; a server that accepts a socket cannot
                    // stall it forever.
                    let mut resolved_origin: Option<&str> = None;
                    let mut last_error = "No model origin is reachable.".to_string();
                    for origin in file.origins {
                        let response = client.head(format!("{origin}/{}", file.name)).timeout(Duration::from_secs(15)).send().await;
                        if response.ok().filter(|r| r.status().is_success()).is_some() { resolved_origin = Some(origin); break; }
                        last_error = format!("{origin} did not report the model file.");
                    }
                    let origin = resolved_origin.ok_or(last_error)?;
                    let mut response = tokio::time::timeout(
                        Duration::from_secs(30), client.get(format!("{origin}/{}", file.name)).send()
                    ).await.map_err(|_| "The model server did not send response headers within 30 seconds. Retry the download.".to_string())?
                        .map_err(|_| "Model download failed. Check your connection and retry.".to_string())?
                        .error_for_status().map_err(|_| "The official model download is unavailable. Retry later.".to_string())?;
                    if !response.status().is_success() { return Err("The official model URL redirected unexpectedly.".into()); }
                    let mut file_handle = tokio::fs::File::create(stage.join(file.name)).await.map_err(|_| "Cannot create a staged model file.".to_string())?;
                    let mut hash = md5::Context::new();
                    let mut file_size = 0u64;
                    loop {
                        let chunk = tokio::time::timeout(Duration::from_secs(30), response.chunk()).await
                            .map_err(|_| "Model download stalled. Retry the download.".to_string())?
                            .map_err(|_| "Model download was interrupted. Retry the download.".to_string())?;
                        let Some(chunk) = chunk else { break; };
                        file_size += chunk.len() as u64;
                        downloaded += chunk.len() as u64;
                        if downloaded > 600 * 1024 * 1024 || file_size > file.max_bytes {
                            return Err("The official model download exceeds the expected size.".into());
                        }
                        file_handle.write_all(&chunk).await.map_err(|_| "Cannot save the model download. Check available disk space.".to_string())?;
                        hash.consume(&chunk);
                        self.publish(generation, |s| {
                            s.downloaded_bytes = downloaded;
                            if s.total_bytes.is_some_and(|total| downloaded > total) { s.total_bytes = None; }
                        });
                    }
                    file_handle.sync_all().await.map_err(|_| "Cannot finish saving the downloaded model.".to_string())?;
                    drop(file_handle);
                    if format!("{:x}", hash.compute()) != file.md5 {
                        return Err("Model checksum mismatch. The incomplete model was discarded; retry the download.".into());
                    }
                }
                _ => return Err("Model download plan is invalid.".to_string()),
            }
        }
        Ok(())
    }

    // The indexing loop: one immediate pass, then incremental passes on the
    // configured interval. All embedding runs on blocking threads, paced to
    // roughly half duty cycle so foreground work keeps the machine.
    async fn run(self: Arc<Self>, generation: u64, token: CancellationToken) {
        let mut first = true;
        loop {
            if !self.is_enabled(generation) { return; }
            if first {
                self.publish(generation, |s| s.state = "indexing".into());
            }
            match self.index_pass(generation, &token).await {
                Ok(()) => {
                    self.publish(generation, |s| { s.state = "ready".into(); s.message = None; });
                    first = false;
                }
                Err(error) if error == CANCELLED => return,
                Err(error) => { self.fail(generation, error, false); return; }
            }
            let interval = semantic_interval();
            tokio::select! {
                biased;
                _ = token.cancelled() => return,
                _ = tokio::time::sleep(interval) => {}
            }
        }
    }

    async fn index_pass(self: &Arc<Self>, generation: u64, token: &CancellationToken) -> Result<(), String> {
        let pool = self.read_database_pool().await?;
        let store = VectorStore::open(&self.root).await?;
        let messages: Vec<RawMessage> = collect_messages(&pool).await?;
        let stored = store.message_fingerprints().await?;
        let live: Vec<String> = messages.iter().map(|message| message.message_id.clone()).collect();
        store.prune_messages(&live).await?;
        for message in messages {
            if token.is_cancelled() { return Err(CANCELLED.into()); }
            let passages = build_passages(&message);
            let fresh = passages.first().map(|passage| passage.message_fingerprint.clone());
            let unchanged = fresh.as_ref().is_some_and(|fingerprint| {
                stored.get(&message.message_id).is_some_and(|known| known == fingerprint)
            });
            if unchanged { continue; }
            let texts: Vec<String> = passages.iter().map(|passage| passage.content.clone()).collect();
            let vectors = if texts.is_empty() { Vec::new() } else {
                let manager = self.clone();
                let started = Instant::now();
                let embedded = tauri::async_runtime::spawn_blocking(move || {
                    let embedder = manager.embedder_handle()?;
                    embedder.embed_passages(&texts)
                }).await.map_err(|_| "Semantic indexing task failed.".to_string())??;
                // Pace to about half duty cycle: sleep as long as the batch took.
                tokio::time::sleep(started.elapsed()).await;
                embedded
            };
            store.replace_message_passages(&message.message_id, &passages, &vectors).await?;
            let indexed = store.count_passages().await?;
            self.publish(generation, |s| s.indexed_documents = Some(indexed));
        }
        let indexed = store.count_passages().await?;
        self.publish(generation, |s| s.indexed_documents = Some(indexed));
        Ok(())
    }

    // In-process query: embed the query, cosine-search the vector store, and
    // map the passages onto the searcher contract.
    async fn query(self: &Arc<Self>, query: String, limit: u32) -> Result<SearchResponse, String> {
        if query.trim().is_empty() { return Ok(SearchResponse { hits: Vec::new() }); }
        {
            let inner = self.inner.lock().unwrap();
            if inner.closing { return Err("sndmail is quitting.".into()); }
            if !inner.status.supported { return Err("Local semantic search is not supported on this platform.".into()); }
            if !inner.status.enabled { return Err("Local semantic search is disabled.".into()); }
            if !matches!(inner.status.state.as_str(), "ready" | "indexing") {
                return Err("Local semantic search is still starting up or indexing.".into());
            }
        }
        let manager = self.clone();
        let query_text = query;
        let vector = tauri::async_runtime::spawn_blocking(move || {
            let embedder = manager.embedder_handle()?;
            embedder.embed_query(&query_text)
        }).await.map_err(|_| "Semantic search task failed.".to_string())??;
        let store = VectorStore::open(&self.root).await?;
        let scored = store.search(&vector, limit as usize).await?;
        let hits = scored.into_iter().map(|passage| SearcherHit {
            id: passage.doc.id,
            title: passage.doc.title.clone(),
            subtitle: passage.doc.subtitle,
            snippet: Some(passage.doc.snippet),
            tags: passage.doc.tags,
            metadata: passage.doc.metadata,
            match_kind: Some("semantic".into()),
            relevance: Some(passage.score as f64),
            semantic_evidence: Some(SemanticEvidence {
                passage: passage.doc.content,
                title_context: Some(passage.doc.title),
                distance: 1.0 - passage.score as f64,
            }),
        }).collect();
        Ok(SearchResponse { hits })
    }

    async fn fail_async(self: &Arc<Self>, generation: u64, message: String, model_error: bool) {
        let manager = self.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || manager.fail(generation, message, model_error)).await;
    }

    fn fail(self: &Arc<Self>, generation: u64, message: String, model_error: bool) {
        let _transition = self.transition.lock().unwrap();
        let mut inner = self.inner.lock().unwrap();
        if !Self::current(&inner, generation) { return; }
        inner.cancel.cancel();
        inner.status.state = "error".into();
        inner.status.message = Some(message);
        if model_error { inner.status.model_state = "error".into(); }
        drop(inner);
        // A broken model never survives the failure that reported it.
        self.drop_embedder();
    }

    pub fn shutdown(&self) {
        let mut inner = self.inner.lock().unwrap();
        if inner.closing { return; }
        inner.closing = true;
        inner.cancel.cancel();
        inner.generation += 1;
        drop(inner);
        self.reaper_cancel.cancel();
        self.drop_embedder();
    }
}

pub fn install(app: &tauri::AppHandle) {
    let manager = Arc::new(SemanticSearchManager::new(app));
    app.manage(manager.clone());
    // Unload the model after an idle window so nothing stays resident.
    let sweep_token = manager.reaper_cancel.clone();
    let sweeper = manager.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                biased;
                _ = sweep_token.cancelled() => break,
                _ = tokio::time::sleep(EMBEDDER_SWEEP) => {
                    let mut slot = sweeper.embedder.lock().unwrap();
                    if slot.as_ref().is_some_and(|(_, last_used)| last_used.elapsed() >= EMBEDDER_IDLE) {
                        *slot = None;
                    }
                }
            }
        }
    });
    manager.resume();
}

#[tauri::command]
pub fn semantic_search_status(manager: tauri::State<'_, Arc<SemanticSearchManager>>) -> Status {
    manager.status()
}

#[tauri::command]
pub async fn semantic_search_set_enabled(manager: tauri::State<'_, Arc<SemanticSearchManager>>, enabled: bool) -> Result<Status, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.set_enabled(enabled)).await
        .map_err(|_| "Semantic search settings task failed.".to_string())?
}

#[tauri::command]
pub async fn semantic_search_download_model(manager: tauri::State<'_, Arc<SemanticSearchManager>>) -> Result<Status, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.download_model()).await
        .map_err(|_| "Model download task could not start.".to_string())?
}

#[tauri::command]
pub async fn semantic_search_query(manager: tauri::State<'_, Arc<SemanticSearchManager>>, query: String, limit: Option<u32>) -> Result<SearchResponse, String> {
    let limit = limit.unwrap_or(50).clamp(1, 100);
    let manager = manager.inner().clone();
    manager.query(query, limit).await
}

#[tauri::command]
pub async fn semantic_search_reindex(manager: tauri::State<'_, Arc<SemanticSearchManager>>) -> Result<Status, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.reindex()).await
        .map_err(|_| "Mail reindex task could not start.".to_string())?
}
