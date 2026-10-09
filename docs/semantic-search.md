# Local semantic search runtime

sndmail can run an optional local semantic search engine. It is not a separate
service: the engine runs inside the sndmail process itself, with no servers,
ports, or helper processes of any kind. The controls live in Settings →
Semantic Search, which also manages the model download. Mail and embeddings
never leave the machine; downloading model files does not upload mail.

## Lifecycle

- Semantic search is opt-in. The base keyword search (SQLite FTS5) is always
  on and is never replaced; the semantic layer only adds matches on top.
- Enabling it downloads the multilingual E5 Small model (~453 MiB ONNX, plus a
  ~17 MB tokenizer file). An existing model from an earlier sndmail version is
  reused; only missing files are fetched. Downloads are atomic and resumable.
- While enabled, indexing runs inside sndmail whenever the app is open: a
  background pass every 5 minutes by default (`SNDMAIL_SEMANTIC_INTERVAL_SECONDS`,
  clamped to 60–3600) embeds new or changed mail in paced batches (~50% duty
  cycle) so indexing stays a background task, never a foreground stall. An
  initial index of a large mailbox can take a while; incremental passes are
  short.
- Disabling it stops indexing and unloads the model from memory. The model
  files and the index are retained on disk, so re-enabling is quick. Nothing
  runs while it is off: no processes, no ports, no memory held.
- The model is loaded on demand for indexing and searches, and dropped again
  after roughly two idle minutes, so an enabled-but-idle sndmail holds no
  model memory.
- Model download, readiness, indexing progress, and errors are shown in
  Settings → Semantic Search. The engine indexes sndmail mail, not arbitrary
  folders.
- Supported on macOS and Linux, x64 and arm64. Other platforms report
  unsupported.

## Storage

- Model files live under `~/Library/Application Support/com.anydaysomething.sndmail/semantic-search/models/`
  (platform-equivalent path elsewhere), managed from Settings — never baked
  into the app bundle.
- Embeddings live in a sidecar SQLite database (`vectors.db` in the same
  semantic-search directory), one row per passage, grown incrementally and
  pruned as mail disappears. It is separate from the main sndmail database and
  can be deleted at any time; a reindex rebuilds it.
- Search embeds the query on demand and scans the sidecar by cosine
  similarity, so a semantic query costs one short CPU burst — no resident
  index in RAM.
