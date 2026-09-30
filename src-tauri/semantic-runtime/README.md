# sndmail semantic runtime resources

This directory is the native resource boundary. The source slice does not include
downloaded binaries, a model, a signed application, or a verified release.

## Build preparation contract

`node scripts/prepare-semantic-search.mjs` prepares the complete macOS runtime and
fails the build if any required resource is unavailable. It automatically obtains
pinned Typesense 30.2 from its official archive, verifies SHA256 before extraction,
and obtains the checksum-pinned upstream LICENSE.txt. It never installs npm
packages, downloads models, or replaces global executables. Node >=22 and worker
build dependencies must already be available locally.

`--offline` (or `SNDMAIL_SEMANTIC_OFFLINE=1`) makes no network requests and requires
intact cached Typesense archive/license assets or explicit local binary/license
overrides. `--strict` (or `SNDMAIL_SEMANTIC_STRICT=1`) also fails on an unsupported
target. Supported macOS builds always fail when resources are incomplete.
Offline mode also skips timestamped codesigning, which would contact Apple's
timestamp service. Offline preparation must be followed by the normal online
release-signing step before distribution; the manifest records this distinction.

```bash
npm run semantic:prepare
npm run semantic:prepare -- --offline
npm run semantic:prepare -- --strict
```

Outputs, relative to the Tauri resource directory:

- `semantic-runtime/node`: locally provisioned Node >=22 executable.
- `semantic-runtime/typesense-server`: locally provisioned Typesense executable.
- `semantic-runtime/indexer.cjs`: bundled worker with no external npm dependencies.
- `semantic-runtime/node.license.txt`: actual license supplied with that Node build.
- `semantic-runtime/typesense-server.license.txt`: actual Typesense license text.
- `semantic-runtime/typesense-server.source.txt`: archive provenance and source notice.
- `semantic-runtime/indexer.cjs.license.txt`: licenses from bundled dependencies.
- `semantic-runtime/runtime-manifest.json`: readiness, architecture, hashes, notices.

Preparation is macOS arm64/x64 only. CARGO_BUILD_TARGET determines architecture
when present and must agree with any explicit architecture override. Cross-arch
macOS preparation, including universal targets, fails explicitly; prepare each
architecture on a matching host. Unsupported non-macOS targets explicitly disable
the feature and fail only in strict mode. Generated stale
resources are removed when their preparation fails; live model/index data is
never touched. Native Settings must check resource availability and report missing
runtime support. The parent app owns Tauri resource mappings, signature validation,
server priority, enable/disable, model installation, and release packaging.

Explicit local provisioning overrides:

- `SNDMAIL_SEMANTIC_NODE_PATH`, `SNDMAIL_SEMANTIC_NODE_LICENSE_PATH`
- `SNDMAIL_SEMANTIC_TYPESENSE_PATH`, `SNDMAIL_SEMANTIC_TYPESENSE_LICENSE_PATH`
- `SNDMAIL_SEMANTIC_BUILD_NODE_MODULES`: optional node_modules containing esbuild and
  html-to-text@10.0.1; otherwise the repository dependencies are used. esbuild may
  resolve through Vite. html-to-text must be available at build time to preserve
  the current body extraction and embedding fingerprints.
- `SNDMAIL_SEMANTIC_TARGET_ARCH`: arm64 or x64 (defaults to the build host).
- `APPLE_SIGNING_IDENTITY`: optionally signs the copied executables with hardened
  runtime; Node uses the existing src-tauri/Entitlements.plist. This does not sign
  or notarize the enclosing app and does not prove a working release signature.

Without a Typesense override, preparation uses the pinned official release and
keeps verified archives/licenses under
node_modules/.cache/velo-semantic-search/typesense/30.2/<architecture>/.
Downloads have size limits, timeouts, unique temporary files, and atomic publication
after verification. Only the recognized server member is extracted to stdout and
written to a known destination; other archive members are not extracted. Cached
archives are revalidated before extraction. No standalone checkout is consulted.

Node still uses explicitly provisioned resources, the build process runtime, or
known local executable locations as build inputs. No global Node is replaced or
downloaded. Architecture, non-system dynamic dependencies, Node >=22, and complete
local license text are checked. Typesense is never executed during preparation:
the verified official archive establishes the default release provenance, and
its license must match the pinned upstream text. Explicit binary overrides require
SNDMAIL_SEMANTIC_TYPESENSE_SHA256, supplied from verified Typesense 30.2 provenance.
The override's bytes must match that checksum; the release owner is responsible
for tying the checksum to the intended release. No data directory or live server
is created to inspect a version.

Typesense 30.2 is pinned. Preparation verifies these official archive hashes:

- https://dl.typesense.org/releases/30.2/typesense-server-30.2-darwin-arm64.tar.gz
  SHA256: 7d8d6d0c33930ad20ea23dd184250547b16615944be891b2078e8a075152fa7e
- https://dl.typesense.org/releases/30.2/typesense-server-30.2-darwin-amd64.tar.gz
  SHA256: 6aa4d2d85838e03fdde9dcef4bf1584a46fc1840a215e5cbed288b63365eae75

Pinned license: https://raw.githubusercontent.com/typesense/typesense/v30.2/LICENSE.txt
SHA256: 8b1ba204bb69a0ade2bfcf65ef294a920f6bb361b317dba43c7ef29d96332b9b
The pin was derived from the coordinator-provided official license file. The
source author has not run provisioning or release validation.

## Worker/native protocol

Spawn directly as a sndmail-owned child, without a persistent shell or daemon:

```text
<resource-dir>/semantic-runtime/node <resource-dir>/semantic-runtime/indexer.cjs <app-data>/semantic-search/worker.json
```

The sole worker argument is the absolute config path. `--config <path>` is also
accepted. The file must be a regular file owned by the current user with no group
or other permissions (normally mode 0600), containing:

```json
{
  "url": "http://127.0.0.1:8108",
  "apiKey": "<local-secret>",
  "collection": "universal-search",
  "sndmailDatabasePath": "<absolute-app-data>/sndmail.db"
}
```

For migration compatibility, `veloDatabasePath` remains accepted when `sndmailDatabasePath` is absent. Canonical `SNDMAIL_SEMANTIC_*` environment variables take precedence; existing `VELO_SEMANTIC_*` variables remain supported.

Credentials are never passed on the command line. Only loopback HTTP(S) is allowed;
URL credentials, non-root paths, redirects, and remote hosts are rejected. Config
is read at startup; restart the worker to apply a config change or force a fresh
scan. A native reindex action must stop/wait/restart this worker without deleting
collections. Stable embedding generations and fingerprints retain completed work.

Every stdout line is a JSON object with `state` (`indexing`, `ready`, or `error`),
`indexedDocuments`, `type`, `timestamp`, and `source: "sndmail"`. Progress can also
include `phase`, `processed`, `embedded`, `reused`, `restMs`, and `cpuBudgetPercent`.
`ready` includes the completed `documents` count. Error records carry only fixed
generic `code`/`message` and `retryable`. No message content, credentials, database
paths, URLs, raw server responses, SQL errors, or stack traces are emitted. Native
code should continuously consume stdout; excessive queued progress is dropped.

The worker checks its original parent every second, handles SIGTERM/SIGINT, and
cancels network calls, SQLite reads, pacing, and idle waits on shutdown. Native
supervision must also terminate/reap the child on disable/quit. The worker itself
does not start/stop Typesense, install a launch agent, or schedule work outside
sndmail's lifetime. It remains alive between scans, defaulting to 300 seconds with
bounded error backoff. `SNDMAIL_SEMANTIC_INTERVAL_SECONDS` is clamped to 60..3600;
backoff is capped at one hour. The worker writes the canonical `sndmail` source; searches for sndmail include legacy `velo` records already in the shared index.

An exclusive lock directory beside the config has one unpredictable owner marker.
Normal shutdown removes only that marker and an empty lock directory. It never
removes standalone locks or another worker's marker. After a forced kill/crash,
native recovery must confirm the prior process has stopped before clearing a
stale lock. Native must allow only one writer for this managed collection.

## Resource budget and preservation

There is one in-flight embedding import, with at most 16 short passages per import.
`UNIVERSAL_SEARCH_CPU_BUDGET_PERCENT` defaults to 50, clamped to 20..100, expressed
as percent of ONE logical CPU. The rest after a successful import is
`elapsed * (logicalCPUs * 100 / budgetPercent - 1)`. On ten logical CPUs, the
default is 5% active duty. This is conservative average-duty pacing, not a hard OS
CPU ceiling. Bursts and server/background work remain possible; resident memory
is not capped. Errors bypass pacing immediately; all pacing is cancellable.
Metadata, unchanged embeddings, and queries are not deliberately delayed.

The copied pipeline preserves original IDs, lexical content, 320-byte passage
format/version, local multilingual-e5-small model, completed-embedding reuse,
fresh scan markers, and parent-first/orphan-passage cleanup. sndmail SQLite is read
through macOS's system /usr/bin/sqlite3 in readonly mode. There is no runtime
dependency on the standalone Raycast checkout, its node_modules, or Homebrew.
No file/Obsidian providers are wired into this worker.

## Model and license notices

The model is `ts/multilingual-e5-small` (384 dimensions), licensed MIT according
to its upstream model card: https://huggingface.co/intfloat/multilingual-e5-small.
Model weights are NOT bundled or downloaded by this preparation script. Settings
must install and validate the selected model in the managed Typesense data/model
directory and retain the upstream model notice/license before starting the worker.
Collection creation can cause Typesense's own public-model downloader to run if
the cache is absent; the native readiness gate must prevent that unintended path.

Node includes MIT and third-party licenses; the complete license shipped with the
chosen Node distribution is required. Typesense is distributed under GPL-3.0;
include the actual upstream license and resolve corresponding-source obligations
for the chosen binary before redistribution. Copying license text alone does not
complete release/license review. JS dependency notices are extracted from the
packages actually included by esbuild, not inferred from a package name.

This source slice has not been built, typechecked, executed, signed, or activated
by its author. Independent review and lifecycle/cancellation/runtime validation
remain required before claiming the integrated feature works.
