# Superset setup for sndmail

Configuration for [Superset workspaces](https://docs.superset.sh/setup-teardown-scripts).
Every workspace is an isolated git worktree of this repository, and these scripts
make it usable without manual steps.

```
.superset/
├── config.json      # the lifecycle configuration Superset reads
├── setup.sh         # workspace create: dependencies, untracked files, port
├── run.sh           # Run button: the dev server, on this workspace's port
├── teardown.sh      # workspace delete: stop the dev server, free the port
├── ports.json       # labels for the ports Superset discovers
├── copy-files.txt   # extra files to copy from the main checkout
└── lib/ports.mjs    # per-workspace port allocation
```

## setup

Runs in the new workspace right after it is created:

1. `npm ci` — installs the dependencies from `package-lock.json`.
2. Copies the **untracked and ignored** files of the main checkout
   (`$SUPERSET_ROOT_PATH`) into the workspace: `.env` and other local-only files
   that git cannot carry. Build output, `node_modules`, databases and logs are
   skipped. Extra paths can be added to `copy-files.txt`.
3. Reserves a free dev-server port (4300–4399) for the workspace and records it
   in `~/.superset/port-allocations.json`.

## run

The Run button starts the dev server for this workspace:

- The port reserved during setup is exported as `VITE_DEV_PORT`; `vite.config.ts`
  reads it, and the Tauri dev URL is pointed at it
  (`tauri dev --config '{"build":{"devUrl":"http://localhost:<port>"}}'`).
  Two workspaces therefore never fight over port 1420.
- `SNDMAIL_RUN_MODE` selects what runs: `tauri` (desktop app, default when
  `cargo` is available), `web` (Vite only), `auto` (the default).
- The Rust build is shared through `CARGO_TARGET_DIR` (`~/.cache/sndmail-cargo-target`),
  so a new workspace does not rebuild the whole backend from scratch.
- Note: sndmail is a single-instance app — a second `tauri dev` focuses the
  running instance. Run the desktop app in one workspace at a time; use
  `SNDMAIL_RUN_MODE=web` in the others for UI work.

## teardown

Runs when the workspace is deleted: stops the dev server started in this
workspace (only processes whose working directory is the workspace are killed)
and releases the port reservation.

## Working from staging

New branches — and therefore new workspaces — are cut from `staging`, the
default branch of the repository. `main` is the release branch, `production`
mirrors what has been released. See the "Branch model" section in `AGENTS.md`.

```bash
superset workspaces create \
  --project c42184a4-240d-40a1-ba3a-82498236dbb5 \
  --name fix-login \
  --branch fix/login \
  --base-branch staging \
  --local
```

## Local overrides

`.superset/config.local.json` (gitignored) can prepend or append steps without
touching the shared configuration:

```json
{
  "setup": { "after": ["npm run dev:landing --prefix landing"] }
}
```

User-level overrides live in `~/.superset/projects/<repo-path>/config.json` and
win over this file, key by key.
