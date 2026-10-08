# Semantic search research: efficient options for sndmail

Research date: 2026-10-08. Question: how should sndmail provide useful semantic
search over a ~10,000-email inbox (≈30k–80k text passages) with the smallest
possible memory/CPU/energy footprint — "sndmail cannot hog 10GB RAM in idle.
This needs to be a background, as small as possible app."

Evidence is labeled throughout:

- **[verified]** — confirmed in sndmail's own code/docs or directly fetched sources.
- **[vendor]** — benchmark/claim published by the project itself (maintainer-run).
- **[third-party]** — benchmark by someone else, single machine/run.
- **[estimate]** — arithmetic or inference; needs measurement on sndmail.

Primary sources are linked inline; all wall-times below are machine-dependent
and should be treated as orders of magnitude, not promises.

## 1. Where we are today (the baseline to beat)

sndmail already ships an opt-in semantic runtime: Typesense server + Node
indexer worker + a hybrid query engine, merged on top of the always-on SQLite
FTS5 keyword search **[verified]**.

What it costs while **enabled and idle**:

- The Typesense server stays resident holding the whole index in RAM — Typesense
  is an in-memory datastore by design; there is no mmap/on-demand mode in 30.x
  **[vendor: Typesense system requirements]**. Our collection embeds *inside the
  server process* via Typesense's built-in `ts/multilingual-e5-small` embedding
  (`scripts/semantic-search/typesense.ts`), so the ~453 MiB fp32 model sits in
  server RSS **[verified; download size from docs/semantic-search.md]**.
- The Node indexer worker stays resident, sleeping between incremental rescans
  (default every 300s) **[verified]**.
- Our own planning doc forecasts **1–2 GB server RAM plus worker at ~7,500
  messages** — estimates, not measurements **[verified, docs/semantic-search.md]**.
- While **disabled**, all child processes are killed; only model and index stay
  on disk — genuinely 0% idle **[verified]**.

So the current design already meets "0% when disabled", but "enabled" plausibly
costs ~1–2 GB resident. That is far from 10 GB, yet it is exactly the
"memory-burning background monster" the requirement rules out. The rest of this
memo asks what an enabled-but-frugal design looks like instead.

## 2. How other apps do it

### DEVONthink — not vector search at all

The common belief that DEVONthink does semantic/vector search is wrong.
Company staff, repeatedly through Feb 2026: "there is no semantic search in the
internal AI… we'll consider a vector database and semantic search for future
releases" **[verified, devontechnologies discourse #82238, #78416, #86266]**.
Its AI is statistical — word frequency, concordance, co-occurrence powering
See Also/Classify/"Similar Words" **[verified, devontechnologies.com/apps/devonthink/ai]**.
DEVONthink 4's "contextually similar words" search is lexical expansion, not
embeddings **[verified, /apps/devonthink/new]**. Footprint guidance: an 8 GB
machine handles ~100k items / 1M unique words per database because the text
index is RAM-resident **[verified, DT FAQ]** — i.e. even the incumbent's
"AI search" is a word index, not a model in RAM. MailMate, EagleFiler and Yep
are likewise keyword/statistical only **[verified, product docs]**.

**Lesson:** the most respected local document manager in this niche argues for
*years* that a compact statistical/lexical index beats a resident embedding
model for search, and only "might consider" vectors. It is precedent that
semantic search can be an optional add-on rather than the core.

### Other desktop/local-first apps

- **Obsidian Smart Connections**: local embeddings, "zero setup" — but current
  docs do not pin model, index format, or footprint; older forks used
  BGE-micro-v2 (384-d) in vault-local JSON **[verified README + version-specific
  forks]**. Bounded costs acknowledged, never quantified.
- **Logseq community semantic search**: no bundled model — embeddings via a
  configured API, default local Ollama (nomic-embed-text) **[verified, github
  twaugh/logseq-plugin-semantic-search]**. A separate MCP project uses LanceDB +
  RRF hybrid with user-installed Ollama models **[verified, mcp-logseq]**.
- **Apple NaturalLanguage `NLContextualEmbedding`**: OS-provided models with
  explicit `load()`/`unload()`, asset download on demand; sizes/parameters not
  published, no ANN/search index specified **[verified, developer.apple.com]**.
  Apple Mail documents summarization/priority, not semantic search **[verified]**.
- **Zotero ZotSeek**: closest analog to what we want — Transformers.js worker,
  bundled Nomic Embed Text v1.5 (~131 MB, 768-d), vectors in a side SQLite DB,
  hybrid semantic+keyword via RRF, author-reported ~70 ms cached search
  **[verified README / vendor]**. Idle RAM not published.
- **semlocal / git-search**: FastEmbed/ONNX all-MiniLM-L6-v2 (~25 MB model),
  SQLite storage, exact brute-force cosine, no server, per-command process —
  zero idle by construction **[verified README]**. Semantic-only, manual
  indexing, CLI-scale.
- **Mailspring**: semantic search is an early POC plugin (bring-your-own
  provider, LanceDB) **[verified community post]**. **eM Client**: keyword only.
  **Raycast example**: SQLite vectors but cloud (Gemini) embeddings.
- **agent-brain** (github.com/SpillwaveSolutions/agent-brain): Python FastAPI +
  Uvicorn server, ChromaDB (HNSW), LlamaIndex BM25, graph store; OpenAI
  embeddings by default, Ollama optional **[verified, fetched README]**.
  Rejected as a dependency: persistent Python service + server process +
  by-default cloud calls is architecturally the opposite of the idle-budget
  goal. Usable only as design inspiration (its hybrid BM25+vector+RRF pattern
  is the same fusion we already run).

**Pattern across the field:** nobody with an idle budget runs a resident
embedding server. Everything small is either OS-provided (Apple), a
short-lived/ per-query process over SQLite vectors (semlocal, ZotSeek-style),
or an external Ollama the user runs themselves.

## 3. Technology comparison at our scale

Scale anchor: **50,000 passages × 384 dimensions** (representative of a
10k-email inbox at 30k–80k passages).

Storage of raw vectors **[verified arithmetic]**:

| Precision | 50k × 384 | Notes |
|---|---|---|
| fp32 | 76.8 MB | exact |
| int8 | 19.2 MB | ~2× faster scan, ~same recall after calibration |
| 1-bit | 2.4 MB | needs float rescore of top-k for quality |

Query scan cost: exact brute-force at this size is 38.4 MFLOPs — memory
bandwidth bound, **~5–20 ms in-process** **[vendor: alexgarcia.xyz]**;
sqlite-vec on-disk vec0 full scan measured **~30–40 ms at 50k** and <75 ms at
100k (M1 mini) **[vendor]**; third-party bake-off: 100k rows = 67.8 ms fp32 /
17.4 ms int8 (3.97 ms with quantized pages preloaded, 374 MB→37.4 MB page cache
RAM) **[third-party: Bambini]**. Inserts ~12 µs/vector **[third-party]**.

Candidate technologies:

| Option | Idle cost | Query path | Incremental | Verdict |
|---|---|---|---|---|
| **Typesense (current)** | resident server + model + index: forecast 1–2 GB **[verified doc estimate]** | fastest warm (tens of ms) **[estimate]** | automatic background rescan | powerful, but the idle problem itself |
| **sqlite-vec in sndmail.db** | **0** — no new process; scans bounded by SQLite page cache **[vendor]** | 30–40 ms scan + model embed ≈ sub-second cold-start total **[estimate]** | cheap vec0 inserts, no structure rebuild **[third-party]** | **best fit** |
| **Brute-force, no index at all** (vectors as BLOBs, scan in one-shot process) | 0 | ~5–20 ms scan in-process **[vendor]** | trivial (rewrite rows) | simplest variant of the above |
| **usearch (i8, mmap view)** | 0 when no process; index served from disk **[vendor README]** | single-digit ms claims **[vendor]** | sidecar index to build/refresh | upgrade path only if queries must be faster |
| **hnswlib** | loads whole index into RAM on open **[vendor]** | fast | yes | rejected (RAM-resident) |
| **LanceDB** | page-cache over columnar files, low-ms flat at 50k **[third-party]** | good | segment compaction | rejected: arrow/datafusion-class dependency stack |
| **Qdrant local / Milvus Lite** | embedded but heavy dep/service machinery **[vendor]** | no measured win at 50k | — | rejected: overbuilt |

Embedding models (384-d class):

- **all-MiniLM-L6-v2**: 22M params, int8 ≈ 23–25 MB, fp32 ≈ 86–90 MB
  **[vendor: HF/philschmid]**; embeds 128 tokens in ~12 ms CPU, ONNX session
  ~33.5 ms **[vendor: Qdrant]**. English-centric.
- **multilingual-e5-small**: 118M params — int8 ≈ 118–130 MB, fp32 ≈ our
  observed 453 MiB download **[verified observation + vendor HF card]**.
  ~5× MiniLM's footprint; that is the price of multilinguality.
- **bge-small / gte-small**: 33M params, ~34 MB quantized, English.
- **Apple NLContextualEmbedding**: free of bundling, but sizes/quality
  unpublished and macOS-only **[verified]**.

Cold-start budget for a one-shot query process: spawn (50–150 ms) + ONNX
session (~35 ms) + one embed (10–20 ms) + vector scan (5–40 ms) ≈ **well under
~0.5 s end-to-end** **[estimate from vendor components]**. sndmail's search UI
already treats semantic results as an async, additive merge over instant FTS
(`SearchBar` merges hits when they arrive, silent fallback otherwise
**[verified]**), so sub-second cold semantic latency is acceptable by design.

## 4. Cost model for a 10k-email inbox (enabled, idle)

| Architecture | Idle RSS | Idle CPU | Query | Background indexing |
|---|---|---|---|---|
| Typesense enabled (today) | **~1–2 GB est.** (server + fp32 E5 in server + worker) **[verified estimate, not measured]** | ~0 (worker sleeps 300s) | fast warm | resident server must be alive during embed batches |
| Typesense stopped-when-idle, start on demand | 0 between uses | 0 | + server/model load seconds cold **[estimate]** | periodic wake-ups defeat "idle 0" |
| **One-shot process + SQLite vectors (proposed)** | **0** — nothing resident | **0** | ~0.3–1 s cold, FTS instant meanwhile | short burst worker after syncs: spawn, embed pending messages, exit |
| agent-brain stack | FastAPI+Chroma+Python: hundreds of MB **[estimate]** | always | fast | always-on server |

Disk: vectors int8 in existing sndmail.db ≈ **20 MB per 50k passages**, plus
int8 model 25 MB (MiniLM) or ~120 MB (e5-small) — vs today's ~453 MiB model +
Typesense index files **[verified sizes/estimates as labeled]**.

## 5. Ranked recommendation

1. **Target architecture — FTS5 (always on) + one-shot semantic layer over
   SQLite vectors.** Store passage vectors with `sqlite-vec` (or plain BLOBs +
   exact scan — they are equivalent at 50k) inside sndmail.db; embed with a
   quantized 384-d model in a short-lived process that (a) answers queries and
   (b) after syncs, embeds only *new/changed* passages in a paced burst then
   exits. Zero resident processes, ~20 MB index, exact recall, reuses the
   DB we already ship, and our existing hybrid merge (FTS + semantic, RRF-style
   in `semanticSearchMerge.ts`) keeps working unchanged **[verified code]**.
   Trade-off: no resident fast-path — every query pays cold start (<1 s), and
   initial backfill of 10k mails still takes paced background bursts (same
   "hours for initial index" reality as today, but at low priority with no
   server held in RAM).
2. **Model choice:** keep **multilingual-e5-small int8 (~120 MB)** if
   multilingual quality matters (it is what today's index already uses —
   `ts/multilingual-e5-small`), else MiniLM int8 (~25 MB). Apple
   `NLContextualEmbedding` is worth a measurement spike: zero bundled bytes,
   explicit load/unload, but undisclosed size/quality and macOS-only.
3. **Usearch (i8, mmap view)** as the escalation path only if measured query
   latency (30–40 ms scan vs single-digit ms) ever matters — at 10k emails
   it will not.
4. **Keep today's Typesense runtime** only if measured real RSS on our corpus
   comes in far under the 1–2 GB estimate (measure first — see below). Nothing
   in the research suggests it will: an in-memory index + fp32 model in-process
   is structural, not a tuning issue.
5. **Rejected:** agent-brain and any Python/server stack; hnswlib, LanceDB,
   Qdrant local, Milvus Lite; cloud embeddings (privacy + network dependency).

## 6. Decisive measurements before any migration

1. **Measure actual Typesense-enabled RSS today** on a real ~7.5k–10k mailbox
   (`ps`/`footprint` on server + worker, idle and mid-reindex). Our 1–2 GB
   number is a planning estimate, not data.
2. **Quality eval on real mail:** take ~200 real queries with known relevant
   threads, compare FTS-only vs hybrid with e5-small vs MiniLM (recall@10) —
   semantic value over FTS on mail is the premise worth validating.
3. **Cold-start timing** of a prototype one-shot embed+scan process on target
   machines (spawn + model load + scan), to confirm the <1 s budget.
4. **Backfill throughput:** paced embedding of 10k mails with int8 e5-small —
   confirm bursts fit the existing background pacing model without a resident
   server.

## 7. Limitations

- Nearly all latency figures are maintainer-published (Typesense, sqlite-vec,
  usearch, Qdrant, philschmid) on their machines; the third-party numbers are
  single-run. None were measured on sndmail's corpus or hardware.
- 1-bit recall figures in circulation come from OpenAI-sized embeddings;
  expect worse on 384-d models — hence int8 (or bit+float rescore) as the
  recommended precision.
- No cited benchmark covers incremental embedding under concurrent mail sync;
  item 4 above is required before committing.
- Quality claims for e5-small vs MiniLM on *email* text are untested here;
  mail has short subjects, signatures and quotes that can skew similarity.

## Sources

- Current architecture/costs: `docs/semantic-search.md`, `scripts/semantic-search/*`, `src-tauri/src/semantic_search.rs` **[verified]**
- DEVONthink: https://discourse.devontechnologies.com/t/broader-ai-intelligence/82238 · /78416 · /86266 · https://www.devontechnologies.com/apps/devonthink/ai · DT FAQ (database tag)
- Obsidian: https://github.com/brianpetro/obsidian-smart-connections · Logseq: https://github.com/twaugh/logseq-plugin-semantic-search · https://github.com/ergut/mcp-logseq/blob/main/VECTOR_SEARCH.md
- Apple: https://developer.apple.com/documentation/naturallanguage/nlcontextualembedding · /nlembedding
- ZotSeek: https://github.com/introfini/ZotSeek · semlocal: https://github.com/Minitour/semlocal · git-search: https://github.com/forjd/git-search · Mailspring POC: https://community.getmailspring.com/t/semantic-ai-search-for-mailspring/14520
- agent-brain: https://github.com/SpillwaveSolutions/agent-brain
- sqlite-vec: https://github.com/asg017/sqlite-vec · https://alexgarcia.xyz/blog/2024/sqlite-vec-stable-release/ · https://alexgarcia.xyz/sqlite-vec/guides/binary-quant.html · third-party: https://marcobambini.substack.com/p/the-state-of-vector-search-in-sqlite
- usearch: https://github.com/unum-cloud/usearch · hnswlib: https://github.com/nmslib/hnswlib · Ente: https://ente.io/blog/vector-db/
- Models: https://huggingface.co/Xenova/all-MiniLM-L6-v2 · https://huggingface.co/intfloat/multilingual-e5-small · https://www.philschmid.de/optimize-sentence-transformers · https://qdrant.tech/blog/oxidizing-cross-encoders/ · https://qdrant.tech/articles/binary-quantization/
- Typesense: https://typesense.org/docs/guide/system-requirements.html
