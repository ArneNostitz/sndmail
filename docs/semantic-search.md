# Local semantic search runtime

sndmail can own the local Typesense service used for semantic mail search. Its
Settings controls manage the service and download the multilingual E5 Small
embedding model. Mail and embeddings stay on the computer; downloading model
files does not upload mail.

## Lifecycle

- The feature is opt-in. An enabled runtime starts with sndmail.
- Disabling it stops sndmail's search server and indexing worker, retaining their
  stored model and index for later use.
- Quitting sndmail stops the owned processes. Closing a window hides sndmail in the
  tray and is not the same as quitting.
- An unrelated server occupying the search port is a conflict, not permission
  to kill or adopt that process. An existing Homebrew installation is not
  automatically removed.
- Model download, readiness, indexing progress, and errors are shown in Settings.
- This runtime indexes mail, not arbitrary folders. Existing SQLite FTS search
  remains separate; enabling the runtime does not replace sndmail's search adapter.

## Resources

The model download is approximately 453 MiB. Planning estimates for the current
mailbox of roughly 7,500 messages are 1-2 GB of total search data including the
model and 1-2 GB of server RAM, plus the indexing worker. These are estimates,
not limits, and exclude any older standalone search installation left on disk.

Embedding imports run sequentially with background pacing and reuse unchanged
embeddings. Initial indexing may take several hours. Low process priority and
import pacing reduce sustained load; they do not impose a hard instantaneous
CPU limit on Typesense's embedding threads.

## Packaging

`npm run semantic:prepare` prepares the worker and native runtimes in
`src-tauri/semantic-runtime/`; the Tauri production build invokes this step.
On macOS it provisions the pinned official Typesense release and its license,
uses a compatible Node runtime from the build environment, and bundles the
indexer's declared dependencies. Missing required resources fail preparation
rather than silently producing a macOS app without semantic search.

These are build resources, not dependencies users should install with Homebrew.
The embedding model is deliberately not baked into the app bundle and is managed
from Settings instead. Offline preparation requires previously provisioned local
resources and must not make network requests.

The initial native integration targets macOS. Other platforms report the feature
as unsupported. Consult the preparation script's runtime instructions before
producing a distributable build.

Binary redistribution requires the corresponding Typesense, Node, model, and
bundled dependency licenses and notices. A successful local compilation alone
does not establish signing, notarization, or cross-machine portability.
