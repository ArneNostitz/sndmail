#!/usr/bin/env bash
#
# Superset run script for sndmail — starts the dev server for this workspace.
#
# The Run button in Superset executes this in its own pane. Every workspace gets
# its own port (reserved during setup), so parallel workspaces never collide.
#
# Modes (SNDMAIL_RUN_MODE):
#   tauri  (default when cargo is available) full desktop app: Vite dev server
#           on the workspace port + the Tauri shell pointing at it
#   web    Vite dev server only (browser preview, no Tauri IPC)
#   auto   pick tauri if cargo is available, otherwise web
#
# Environment (provided by Superset):
#   SUPERSET_ROOT_PATH      path of the main repository checkout
#   SUPERSET_WORKSPACE_PATH path of this workspace's worktree
#
set -euo pipefail

WORKSPACE="${SUPERSET_WORKSPACE_PATH:-$PWD}"
HERE="$WORKSPACE/.superset"
cd "$WORKSPACE"

step() { printf '\n\033[1m→ %s\033[0m\n' "$1"; }

# ------------------------------------------------------------------- port
PORT="$(node "$HERE/lib/ports.mjs" get --workspace "$WORKSPACE")"
if [ -z "$PORT" ]; then
  PORT="$(node "$HERE/lib/ports.mjs" reserve --workspace "$WORKSPACE" --name "${SUPERSET_WORKSPACE_NAME:-$(basename "$WORKSPACE")}")"
fi
export VITE_DEV_PORT="$PORT"

# Shared cargo target dir: the Rust build of a Tauri app takes minutes, and every
# workspace would otherwise rebuild it from scratch in its own target/ directory.
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/sndmail-cargo-target}"
mkdir -p "$CARGO_TARGET_DIR"

# ------------------------------------------------------------------- mode
MODE="${SNDMAIL_RUN_MODE:-auto}"
if [ "$MODE" = "auto" ]; then
  if command -v cargo >/dev/null 2>&1 && [ -d "$WORKSPACE/node_modules/@tauri-apps/cli" ]; then
    MODE="tauri"
  else
    MODE="web"
  fi
fi

PIDFILE="$HERE/dev-server.pid"
echo $$ > "$PIDFILE"
cleanup() { rm -f "$PIDFILE"; }
trap cleanup EXIT INT TERM

step "Dev server on port $PORT (http://localhost:$PORT) — mode: $MODE"

if [ "$MODE" = "tauri" ]; then
  # The Tauri shell loads http://localhost:<port>, so the dev URL has to follow
  # the port this workspace reserved.
  npm run tauri dev -- --config "{\"build\":{\"devUrl\":\"http://localhost:$PORT\"}}"
else
  npm run dev -- --port "$PORT" --strictPort
fi
