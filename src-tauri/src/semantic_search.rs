//! sndmail-owned local search. No PATH/Homebrew discovery, external process adoption,
//! remote mail upload, or credentials in IPC responses. Settings poll Status.
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, ChildStdout, Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::Manager;
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

const MODEL_ID: &str = "ts/multilingual-e5-small";
const MODEL_DIR: &str = "ts_multilingual-e5-small";
const MODEL_MD5: &str = "59cdc138465277af7094b9b7872c6b7a";
const VOCAB_MD5: &str = "bf25eb5120ad92ef5c7d8596b5dc4046";
const VOCAB: &str = "sentencepiece.bpe.model";
const MODEL_ORIGIN: &str = "https://models.typesense.org/public/multilingual-e5-small";
const URL: &str = "http://127.0.0.1:8108";
const COLLECTION: &str = "universal-search";
const CANCELLED: &str = "Semantic search operation cancelled.";
const CONFLICT: &str = "Port 8108 or 8107 is already in use. Stop the other local search service yourself, then enable sndmail semantic search again. sndmail will not use or stop that service.";

// The bundled Node runtime supervises each child without a shell. A crashed sndmail
// is noticed within 2s; its child gets SIGTERM, then SIGKILL after another 2s.
// Normal shutdown also terminates the private process group and reaps this Node
// process. This watchdog is not a system service and does not restart anything.
const SUPERVISOR: &str = r#"
const {spawn} = require('node:child_process');
const [owner, program, ...args] = process.argv.slice(1);
let child, timer, stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  if (!child || !child.pid) return process.exit(0);
  child.kill('SIGTERM');
  setTimeout(() => child.kill('SIGKILL'), 2000).unref();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
child = spawn(program, args, {stdio: 'inherit', env: process.env});
child.on('error', () => process.exit(1));
child.on('exit', code => process.exit(stopping ? 0 : (code ?? 1)));
timer = setInterval(() => {
  try {
    if (process.ppid !== Number(owner)) return stop();
    process.kill(Number(owner), 0);
  } catch { stop(); }
}, 2000);
"#;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    supported: bool,
    enabled: bool,
    // unsupported | disabled | model_required | downloading | starting |
    // indexing | ready | conflict | error
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
struct Config {
    enabled: bool,
    api_key: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkerOwnership {
    group_id: u32,
    owner_token: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkerLockMarker {
    pid: u32,
    owner_token: String,
}

#[derive(Default)]
struct Children {
    server: Option<Child>,
    worker: Option<Child>,
}

struct Inner {
    status: Status,
    config: Option<Config>,
    generation: u64,
    cancel: CancellationToken,
    closing: bool,
    children: Children,
}

pub struct SemanticSearchManager {
    root: PathBuf,
    resources: PathBuf,
    database: PathBuf,
    discovery: Option<PathBuf>,
    inner: Mutex<Inner>,
    retiring: Mutex<Vec<Arc<Mutex<Option<Children>>>>>,
    // Serialize short mutations, launches and owned-child cleanup, never a
    // model transfer, hashing pass, readiness request or worker lifetime.
    transition: Mutex<()>,
}

fn random_hex() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|_| "Cannot generate a private search key.".to_string())?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn worker_lock_token() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).map_err(|_| "Cannot generate a private worker ownership token.".to_string())?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    Ok(format!("{}-{}-{}-{}-{}", &hex[..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..]))
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

fn model_config_valid(value: &serde_json::Value) -> bool {
    // Pin the complete official configuration as well as both file checksums.
    *value == serde_json::json!({
        "model_md5": MODEL_MD5, "vocab_file_name": VOCAB,
        "vocab_md5": VOCAB_MD5, "model_type": "xlm_roberta",
        "indexing_prefix": "passage:", "query_prefix": "query:"
    })
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
    let config = fs::read(path.join("config.json")).ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
    config.as_ref().is_some_and(model_config_valid)
        && hash_file(&path.join("model.onnx"), token).is_ok_and(|hash| hash == MODEL_MD5)
        && hash_file(&path.join(VOCAB), token).is_ok_and(|hash| hash == VOCAB_MD5)
}

impl SemanticSearchManager {
    fn new(app: &tauri::AppHandle) -> Self {
        let data = app.path().app_data_dir().ok();
        let resources = app.path().resource_dir().ok().map(|p| p.join("semantic-runtime"));
        let root = data.as_ref().map(|p| p.join("semantic-search")).unwrap_or_default();
        let supported = cfg!(all(any(target_os = "macos", target_os = "linux"), any(target_arch = "aarch64", target_arch = "x86_64")))
            && data.is_some()
            && resources.as_ref().is_some_and(|p| {
                ["node", "typesense-server", "indexer.cjs"].iter().all(|name| p.join(name).is_file())
            });
        #[cfg(target_os = "macos")]
        let discovery = app.path().home_dir().ok().map(|p| p.join("Library/Application Support/universal-search/velo-runtime.json"));
        #[cfg(not(target_os = "macos"))]
        let discovery: Option<PathBuf> = None;
        let mut status = Status {
            supported, enabled: false,
            state: if supported { "disabled" } else { "unsupported" }.into(),
            model_state: "missing".into(), downloaded_bytes: 0, total_bytes: None,
            indexed_documents: None,
            message: (!supported).then(|| "Local semantic search is unavailable on this platform or the bundled runtime is missing. Install a sndmail build with the semantic runtime included.".into()),
            data_path: root.to_string_lossy().into_owned(), model_id: MODEL_ID.into(),
        };
        let mut config = None;
        if supported {
            let loaded = (|| {
                private_dir(&root)?;
                let path = root.join("config.json");
                let cfg: Config = match fs::read(&path) {
                    Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| "Private semantic search configuration is invalid. Restore config.json before retrying.".to_string())?,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Config { enabled: false, api_key: random_hex()? },
                    Err(_) => return Err("Cannot read private semantic search configuration.".into()),
                };
                if cfg.api_key.len() != 64 || !cfg.api_key.bytes().all(|b| b.is_ascii_hexdigit()) {
                    return Err("Private semantic search key is invalid. Restore config.json before retrying.".into());
                }
                private_write(&path, &encode(&cfg)?)?;
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
            root, resources: resources.unwrap_or_default(),
            database: data.map(|p| p.join("sndmail.db")).unwrap_or_default(), discovery,
            inner: Mutex::new(Inner { status, config, generation: 0, cancel: CancellationToken::new(), closing: false, children: Children::default() }),
            retiring: Mutex::new(Vec::new()),
            transition: Mutex::new(()),
        }
    }

    fn status(&self) -> Status { self.inner.lock().unwrap().status.clone() }

    fn current(inner: &Inner, generation: u64) -> bool {
        !inner.closing && inner.generation == generation && !inner.cancel.is_cancelled()
    }

    fn require(inner: &Inner) -> Result<(), String> {
        if inner.closing { return Err("sndmail is quitting.".into()); }
        if !inner.status.supported { return Err("This sndmail build does not contain a supported semantic runtime.".into()); }
        if inner.config.is_none() { return Err("Private semantic search configuration is unavailable.".into()); }
        Ok(())
    }

    fn discovery(&self, inner: &Inner, state: &str) -> Result<(), String> {
        let (Some(path), Some(config)) = (&self.discovery, &inner.config) else { return Ok(()); };
        match fs::read(path) {
            Ok(bytes) => {
                let existing: serde_json::Value = serde_json::from_slice(&bytes)
                    .map_err(|_| "Cannot update the existing Raycast discovery file: it is not owned by sndmail or the legacy Velo integration.".to_string())?;
                if existing["managedBy"] != "velo" || existing["dataPath"].as_str() != Some(inner.status.data_path.as_str()) {
                    return Err("Another installation owns the Raycast discovery file. Resolve universal-search/velo-runtime.json before enabling.".into());
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && !config.enabled => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {},
            Err(_) => return Err("Cannot read the private Raycast discovery file.".into()),
        }
        private_write(path, &encode(&serde_json::json!({
            "url": URL, "apiKey": config.api_key, "collection": COLLECTION,
            "managedBy": "velo", "dataPath": inner.status.data_path,
            "enabled": config.enabled, "state": state, "modelId": MODEL_ID
        }))?)
    }

    fn publish(&self, generation: u64, update: impl FnOnce(&mut Status)) {
        let mut inner = self.inner.lock().unwrap();
        if !Self::current(&inner, generation) { return; }
        let old_state = inner.status.state.clone();
        update(&mut inner.status);
        if old_state != inner.status.state {
            // No child output or API response is ever copied to status/discovery.
            if self.discovery(&inner, &inner.status.state).is_err() {
                inner.status.message = Some("Search status could not be saved to the private Raycast discovery file.".into());
            }
        }
    }

    fn cancel(inner: &mut Inner) -> (u64, CancellationToken, Children) {
        inner.cancel.cancel();
        inner.generation += 1;
        inner.cancel = CancellationToken::new();
        (inner.generation, inner.cancel.clone(), std::mem::take(&mut inner.children))
    }

    // Register retiring handles before releasing Inner. Quit can therefore
    // synchronously join every cleanup even when a settings command returned.
    fn retire(self: &Arc<Self>, children: Children) {
        if children.server.is_none() && children.worker.is_none() { return; }
        let slot = Arc::new(Mutex::new(Some(children)));
        self.retiring.lock().unwrap().push(slot.clone());
        let manager = self.clone();
        tauri::async_runtime::spawn_blocking(move || {
            {
                let mut pending = slot.lock().unwrap();
                if let Some(children) = pending.take() { stop_children(children); }
            }
            manager.retiring.lock().unwrap().retain(|entry| !Arc::ptr_eq(entry, &slot));
        });
    }

    async fn await_retired(&self) {
        loop {
            let slots = self.retiring.lock().unwrap().clone();
            if slots.iter().all(|slot| slot.try_lock().is_ok_and(|pending| pending.is_none())) { return; }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    fn recover_worker_lock(&self) -> Result<(), String> {
        const BUSY: &str = "The managed mail indexer lock cannot be safely recovered. Another worker may still be running, or its ownership cannot be confirmed. sndmail left the lock untouched.";
        let directory = self.root.join("velo-worker-v1.lock");
        match fs::symlink_metadata(&directory) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Ok(metadata) if metadata.file_type().is_dir() => {},
            _ => return Err(BUSY.into()),
        }
        let ownership_path = self.root.join("worker-owner.json");
        let marker_path = directory.join("owner.json");
        for path in [&ownership_path, &marker_path] {
            let regular = fs::symlink_metadata(path)
                .is_ok_and(|metadata| metadata.file_type().is_file() && metadata.len() <= 4096);
            if !regular { return Err(BUSY.into()); }
        }
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
        // An exact token and confirmed dead owned group are both required.
        // A reused/live worker PID also refuses recovery. Never remove an
        // unknown marker, recursively delete a lock, or touch standalone locks.
        fs::remove_file(&marker_path).map_err(|_| "Cannot remove the confirmed stopped worker's lock marker.".to_string())?;
        fs::remove_dir(&directory).map_err(|_| "The managed worker lock directory contains other entries; sndmail preserved them.".to_string())?;
        Ok(())
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
            if valid && manager.is_enabled(generation) { manager.run(generation, token, false).await; }
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
        // Failure to persist disabling must not leave an owned service running.
        let saved = private_write(&self.root.join("config.json"), &encode(&config)?);
        if enabled { saved.as_ref().map_err(Clone::clone)?; }
        inner.config = Some(config);
        inner.status.enabled = enabled;
        if enabled && inner.status.model_state == "downloading" {
            self.discovery(&inner, "downloading")?;
            return Ok(inner.status.clone());
        }
        let (generation, token, children) = Self::cancel(&mut inner);
        if inner.status.model_state == "downloading" {
            inner.status.model_state = "missing".into();
            inner.status.downloaded_bytes = 0;
            inner.status.total_bytes = None;
        }
        inner.status.state = if enabled {
            if inner.status.model_state == "ready" { "starting" } else { "model_required" }
        } else { "disabled" }.into();
        inner.status.message = None;
        let discovered = self.discovery(&inner, &inner.status.state);
        self.retire(children);
        drop(inner);
        if let Err(error) = saved.and(discovered) {
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
        let (generation, token, children) = Self::cancel(&mut inner);
        inner.status.model_state = "downloading".into();
        inner.status.state = "downloading".into();
        inner.status.downloaded_bytes = 0;
        inner.status.total_bytes = None;
        inner.status.message = Some("Downloading the multilingual model (about 453 MiB).".into());
        let _ = self.discovery(&inner, "downloading");
        self.retire(children);
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
        let reuse_server = inner.children.server.as_mut()
            .is_some_and(|child| matches!(child.try_wait(), Ok(None)));
        let (generation, token, mut children) = Self::cancel(&mut inner);
        if reuse_server { inner.children.server = children.server.take(); }
        inner.status.state = if reuse_server { "indexing" } else { "starting" }.into();
        inner.status.message = Some("Updating the local mail index; existing embeddings are retained.".into());
        let _ = self.discovery(&inner, &inner.status.state);
        self.retire(children);
        drop(inner);
        let manager = self.clone();
        tauri::async_runtime::spawn(async move { manager.run(generation, token, reuse_server).await; });
        Ok(self.status())
    }

    async fn download(self: Arc<Self>, generation: u64, token: CancellationToken) {
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
                let destination = manager.root.join("models").join(MODEL_DIR);
                // Only a verified, fully staged directory becomes the public cache.
                // A previous invalid cache is renamed out of the way, never exposed
                // as a partly updated model. A failed promotion restores it.
                let old = manager.root.join("models").join(format!(".replaced-{}-{generation}", std::process::id()));
                let had_old = destination.exists();
                if had_old { fs::rename(&destination, &old).map_err(|_| "Cannot replace the previous model cache.".to_string())?; }
                if fs::rename(&stage_copy, &destination).is_err() {
                    if had_old { let _ = fs::rename(&old, &destination); }
                    return Err("Cannot install the verified model cache.".into());
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
                if self.is_enabled(generation) { self.clone().run(generation, token.clone(), false).await; }
            }
        } else if let Err(error) = result {
            if !token.is_cancelled() { self.fail_async(generation, error, true).await; }
        }
        let _ = tokio::fs::remove_dir_all(stage).await;
    }

    async fn download_files(&self, generation: u64, stage: &Path) -> Result<(), String> {
        tokio::fs::create_dir_all(stage).await.map_err(|_| "Cannot create model download staging directory.".to_string())?;
        let client = reqwest::Client::builder().https_only(true).no_proxy()
            .redirect(reqwest::redirect::Policy::none()).connect_timeout(Duration::from_secs(15))
            .build().map_err(|_| "Cannot initialize model downloads.".to_string())?;
        let files = [("config.json", None), ("model.onnx", Some(MODEL_MD5)), (VOCAB, Some(VOCAB_MD5))];
        // Content-Length is optional; never substitute an estimate for measured bytes.
        let mut total = Some(0u64);
        for (name, _) in files {
            let response = client.head(format!("{MODEL_ORIGIN}/{name}")).timeout(Duration::from_secs(15)).send().await;
            let length = response.ok().filter(|r| r.status().is_success()).and_then(|r| r.content_length());
            total = total.zip(length).and_then(|(a, b)| a.checked_add(b));
        }
        self.publish(generation, |s| s.total_bytes = total);
        let mut downloaded = 0u64;
        for (name, checksum) in files {
            // The outer download cancellation select also covers this header
            // deadline; a server that accepts a socket cannot stall it forever.
            let mut response = tokio::time::timeout(
                Duration::from_secs(30), client.get(format!("{MODEL_ORIGIN}/{name}")).send()
            ).await.map_err(|_| "The model server did not send response headers within 30 seconds. Retry the download.".to_string())?
                .map_err(|_| "Model download failed. Check your connection and retry.".to_string())?
                .error_for_status().map_err(|_| "The official model download is unavailable. Retry later.".to_string())?;
            if !response.status().is_success() { return Err("The official model URL redirected unexpectedly.".into()); }
            let mut file = tokio::fs::File::create(stage.join(name)).await.map_err(|_| "Cannot create a staged model file.".to_string())?;
            let mut hash = md5::Context::new();
            let mut file_size = 0u64;
            loop {
                let chunk = tokio::time::timeout(Duration::from_secs(30), response.chunk()).await
                    .map_err(|_| "Model download stalled. Retry the download.".to_string())?
                    .map_err(|_| "Model download was interrupted. Retry the download.".to_string())?;
                let Some(chunk) = chunk else { break; };
                file_size += chunk.len() as u64;
                downloaded += chunk.len() as u64;
                if downloaded > 600 * 1024 * 1024 || (name == "config.json" && file_size > 16 * 1024) {
                    return Err("The official model download exceeds the expected size.".into());
                }
                file.write_all(&chunk).await.map_err(|_| "Cannot save the model download. Check available disk space.".to_string())?;
                hash.consume(&chunk);
                self.publish(generation, |s| {
                    s.downloaded_bytes = downloaded;
                    if s.total_bytes.is_some_and(|total| downloaded > total) { s.total_bytes = None; }
                });
            }
            file.sync_all().await.map_err(|_| "Cannot finish saving the downloaded model.".to_string())?;
            drop(file);
            if let Some(expected) = checksum {
                if format!("{:x}", hash.compute()) != expected { return Err("Model checksum mismatch. The incomplete model was discarded; retry the download.".into()); }
            } else {
                let bytes = tokio::fs::read(stage.join(name)).await.map_err(|_| "Cannot read the downloaded model configuration.".to_string())?;
                let config = serde_json::from_slice(&bytes).map_err(|_| "The official model configuration is invalid.".to_string())?;
                if !model_config_valid(&config) { return Err("The official model configuration changed. Update sndmail before downloading this model.".into()); }
            }
        }
        Ok(())
    }

    fn launch(&self, generation: u64, worker: bool) -> Result<Option<ChildStdout>, String> {
        let _transition = self.transition.lock().unwrap();
        let mut inner = self.inner.lock().unwrap();
        if !Self::current(&inner, generation) || !inner.status.enabled { return Err(CANCELLED.into()); }
        let config = inner.config.as_ref().ok_or("Private search configuration is unavailable.")?;
        let node = self.resources.join("node");
        let mut lock_owner_token = None;
        let program;
        let args: Vec<String>;
        if worker {
            if !self.database.is_file() { return Err("The local sndmail database is not available yet. Retry after sndmail finishes starting.".into()); }
            // launch runs only after retired children finish cleanup. Persisted
            // ownership also permits conservative recovery after an app crash.
            self.recover_worker_lock()?;
            let token = worker_lock_token()?;
            let path = self.root.join("worker.json");
            private_write(&path, &encode(&serde_json::json!({
                "url": URL, "apiKey": config.api_key, "collection": COLLECTION,
                "veloDatabasePath": self.database,
                "lockPath": self.root.join("velo-worker-v1.lock"),
                "lockOwnerToken": token
            }))?)?;
            lock_owner_token = Some(token);
            program = node.clone();
            args = vec![self.resources.join("indexer.cjs").to_string_lossy().into_owned(), path.to_string_lossy().into_owned()];
        } else {
            // Bind probes detect external listeners without talking to or killing
            // them. Authenticated /debug plus live-child checks below close the
            // common bind/start race before any collection is modified.
            let api = TcpListener::bind("127.0.0.1:8108").map_err(|_| CONFLICT.to_string())?;
            let peer = TcpListener::bind("127.0.0.1:8107").map_err(|_| CONFLICT.to_string())?;
            let ini = self.root.join("typesense.ini");
            private_write(&ini, format!("[server]\napi-key = {}\n", config.api_key).as_bytes())?;
            program = self.resources.join("typesense-server");
            args = vec![
                format!("--config={}", ini.display()), format!("--data-dir={}", self.root.display()),
                "--api-address=127.0.0.1".into(), "--api-port=8108".into(),
                "--peering-address=127.0.0.1".into(), "--peering-port=8107".into(),
                "--thread-pool-size=2".into(), "--num-collections-parallel-load=1".into(),
                "--num-documents-parallel-load=1".into(), "--max-indexing-concurrency=1".into(),
            ];
            drop((api, peer));
        }
        let mut command = background_command(&node);
        command.arg("-e").arg(SUPERVISOR).arg(std::process::id().to_string()).arg(program).args(args)
            .current_dir(&self.root).env_clear()
            .stdin(Stdio::null()).stderr(Stdio::null())
            .stdout(if worker { Stdio::piped() } else { Stdio::null() });
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        // Children inherit background priority. ONNX thread counts themselves
        // are NOT capped by Typesense's request-pool-size setting.
        let mut child = command.spawn().map_err(|_| "Cannot launch the bundled semantic runtime. Check that this sndmail installation contains executable, signed runtime files.".to_string())?;
        let stdout = child.stdout.take();
        if worker {
            let group_id = child.id();
            // Retain the child before fallible persistence so failure follows
            // the normal owned-child cleanup path, never leaving an orphan.
            inner.children.worker = Some(child);
            private_write(&self.root.join("worker-owner.json"), &encode(&WorkerOwnership {
                group_id,
                owner_token: lock_owner_token.ok_or("Worker ownership token is unavailable.")?,
            })?)?;
        }
        else { inner.children.server = Some(child); }
        Ok(stdout)
    }

    fn alive(&self, generation: u64) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap();
        if !Self::current(&inner, generation) { return Err(CANCELLED.into()); }
        let Children { server, worker } = &mut inner.children;
        for child in [server, worker].into_iter().flatten() {
            match child.try_wait() {
                Ok(None) => {},
                Ok(Some(_)) => return Err("The bundled semantic search process stopped. Disable and enable semantic search to retry.".into()),
                Err(_) => return Err("Cannot read the bundled semantic search process status.".into()),
            }
        }
        Ok(())
    }

    async fn run(self: Arc<Self>, generation: u64, token: CancellationToken, reuse_server: bool) {
        let result = tokio::select! {
            biased;
            _ = token.cancelled() => Err(CANCELLED.to_string()),
            result = self.start_and_monitor(generation, reuse_server) => result,
        };
        if let Err(error) = result {
            if !token.is_cancelled() { self.fail_async(generation, error, false).await; }
        }
    }

    async fn start_and_monitor(self: &Arc<Self>, generation: u64, reuse_server: bool) -> Result<(), String> {
        self.await_retired().await;
        if !reuse_server {
            self.publish(generation, |s| { s.state = "starting".into(); s.message = Some("Starting sndmail's local semantic search service.".into()); });
            let manager = self.clone();
            tauri::async_runtime::spawn_blocking(move || manager.launch(generation, false)).await
                .map_err(|_| "Semantic runtime startup task failed.".to_string())??;
        }
        let key = self.inner.lock().unwrap().config.as_ref().ok_or("Private search configuration is unavailable.")?.api_key.clone();
        let client = reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(2)).build().map_err(|_| "Cannot initialize the local search connection.".to_string())?;
        let deadline = Instant::now() + Duration::from_secs(45);
        loop {
            self.alive(generation)?;
            if Instant::now() >= deadline { return Err("The bundled search service did not become ready within 45 seconds. Disable and enable it to retry.".into()); }
            if let Ok(response) = client.get(format!("{URL}/debug")).header("X-TYPESENSE-API-KEY", &key).send().await {
                if response.status() == reqwest::StatusCode::UNAUTHORIZED || response.status() == reqwest::StatusCode::FORBIDDEN { return Err(CONFLICT.into()); }
                if response.status().is_success() {
                    let debug: serde_json::Value = response.json().await.map_err(|_| "The bundled search service returned invalid readiness data.".to_string())?;
                    if !matches!(debug["version"].as_str(), Some("30.2" | "v30.2")) { return Err("sndmail requires the bundled Typesense 30.2 runtime. Update this sndmail installation.".into()); }
                    let health: serde_json::Value = client.get(format!("{URL}/health")).send().await
                        .map_err(|_| "Cannot check local search readiness.".to_string())?
                        .json().await.map_err(|_| "The local search readiness response is invalid.".to_string())?;
                    if health["ok"] == true { self.alive(generation)?; break; }
                }
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        // An explicit update restarts only the incremental worker. Never drop
        // the collection: unchanged documents must retain their embeddings and
        // remain searchable while the worker scans and prunes stale mail.
        self.publish(generation, |s| { s.state = "indexing".into(); s.message = Some("Indexing local sndmail messages.".into()); });
        let manager = self.clone();
        let stdout = tauri::async_runtime::spawn_blocking(move || manager.launch(generation, true)).await
            .map_err(|_| "Mail indexer startup task failed.".to_string())??.ok_or("Mail indexer progress stream is unavailable.")?;
        let manager = self.clone();
        tauri::async_runtime::spawn_blocking(move || manager.worker_progress(generation, stdout));
        loop {
            tokio::time::sleep(Duration::from_secs(5)).await;
            self.alive(generation)?;
        }
    }

    fn worker_progress(self: Arc<Self>, generation: u64, stdout: ChildStdout) {
        let mut reader = BufReader::new(stdout);
        loop {
            let mut line = Vec::new();
            let result = reader.by_ref().take(64 * 1024).read_until(b'\n', &mut line);
            if !matches!(result, Ok(n) if n > 0) { break; }
            if line.len() >= 64 * 1024 {
                self.fail(generation, "The mail indexer emitted invalid progress data.".into(), false);
                break;
            }
            let Ok(value) = serde_json::from_slice::<serde_json::Value>(&line) else { continue; };
            // Waiting/status snapshots can retain state=error during backoff
            // without repeating retryable. Only an actual error event decides
            // whether to stop the owned runtime.
            if value["type"] == "error" {
                if value["retryable"] == true {
                    // The worker owns its retry/backoff loop. Preserve both
                    // processes and the last complete index while it retries;
                    // subsequent indexing/ready progress clears this status.
                    self.publish(generation, |s| {
                        s.state = "error".into();
                        s.message = Some("Local mail indexing failed temporarily. The indexer will retry automatically; existing indexed mail remains available.".into());
                    });
                    continue;
                }
                self.fail(generation, "Local mail indexing failed. Retry reindexing after checking the mail database and available disk space.".into(), false);
                break;
            }
            self.publish(generation, |s| {
                if let Some(count) = value["indexedDocuments"].as_u64() { s.indexed_documents = Some(count); }
                match value["state"].as_str() {
                    Some("ready") => { s.state = "ready".into(); s.message = None; },
                    Some("indexing") => { s.state = "indexing".into(); s.message = Some("Indexing local sndmail messages.".into()); },
                    _ => {},
                }
            });
        }
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
        inner.status.state = if message == CONFLICT { "conflict" } else { "error" }.into();
        inner.status.message = Some(message);
        if model_error { inner.status.model_state = "error".into(); }
        let _ = self.discovery(&inner, &inner.status.state);
        let children = std::mem::take(&mut inner.children);
        self.retire(children);
    }

    pub fn shutdown(&self) {
        let mut inner = self.inner.lock().unwrap();
        if inner.closing { return; }
        inner.closing = true;
        inner.cancel.cancel();
        inner.generation += 1;
        let children = std::mem::take(&mut inner.children);
        // Keep this authoritative discovery file: stopped/disabled must never
        // cause a Raycast client to fall back to an unrelated Homebrew server.
        let _ = self.discovery(&inner, "stopped");
        drop(inner);
        stop_children(children);
        let retiring = self.retiring.lock().unwrap().clone();
        for slot in retiring {
            let mut pending = slot.lock().unwrap();
            if let Some(children) = pending.take() { stop_children(children); }
        }
    }
}

fn background_command(node: &Path) -> Command {
    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("/usr/bin/taskpolicy");
        command.args(["-b", "/usr/bin/nice", "-n", "15"]).arg(node);
        command
    }
    #[cfg(target_os = "linux")]
    {
        let mut command = Command::new("/usr/bin/nice");
        command.args(["-n", "15"]).arg(node);
        command
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    { Command::new(node) }
}

fn stop_children(children: Children) {
    for mut child in [children.worker, children.server].into_iter().flatten() {
        // Only process groups created and retained by this manager are signaled.
        // Never use pid files, pkill, executable names, ports, or external PIDs.
        if matches!(child.try_wait(), Ok(Some(_))) { continue; }
        #[cfg(unix)]
        unsafe { libc::kill(-(child.id() as i32), libc::SIGTERM); }
        #[cfg(not(unix))]
        let _ = child.kill();
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if matches!(child.try_wait(), Ok(Some(_))) { break; }
            std::thread::sleep(Duration::from_millis(25));
        }
        if !matches!(child.try_wait(), Ok(Some(_))) {
            #[cfg(unix)]
            unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL); }
            #[cfg(not(unix))]
            let _ = child.kill();
            // Bound quit even if the OS cannot immediately reap a stuck child.
            let deadline = Instant::now() + Duration::from_millis(500);
            while Instant::now() < deadline {
                if matches!(child.try_wait(), Ok(Some(_))) { break; }
                std::thread::sleep(Duration::from_millis(25));
            }
        }
    }
}

pub fn install(app: &tauri::AppHandle) {
    let manager = Arc::new(SemanticSearchManager::new(app));
    app.manage(manager.clone());
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
pub async fn semantic_search_reindex(manager: tauri::State<'_, Arc<SemanticSearchManager>>) -> Result<Status, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.reindex()).await
        .map_err(|_| "Mail reindex task could not start.".to_string())?
}
