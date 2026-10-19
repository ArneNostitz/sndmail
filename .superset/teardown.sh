#!/usr/bin/env bash
#
# Superset workspace teardown for sndmail.
#
# Runs when a workspace is deleted. It stops everything the setup/run scripts
# started in this workspace and releases the port reservation so another
# workspace can use it.
#
set -uo pipefail

WORKSPACE="${SUPERSET_WORKSPACE_PATH:-$PWD}"
HERE="$WORKSPACE/.superset"
PIDFILE="$HERE/dev-server.pid"

step() { printf '\n\033[1m→ %s\033[0m\n' "$1"; }
note() { printf '   %s\n' "$1"; }

# ------------------------------------------------------- dev server processes
kill_tree() {
  local pid="$1"
  local child
  for child in $(pgrep -P "$pid" 2>/dev/null); do
    kill_tree "$child"
  done
  kill "$pid" 2>/dev/null || true
}

step "Stopping the dev server of this workspace"

if [ -f "$PIDFILE" ]; then
  PID="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [ -n "${PID:-}" ] && kill -0 "$PID" 2>/dev/null; then
    kill_tree "$PID"
    note "stopped dev server (pid $PID)"
  fi
  rm -f "$PIDFILE"
fi

# Anything still listening on the workspace port: only kill it when the process
# actually runs from this workspace, so a port taken elsewhere is left alone.
PORT="$(node "$HERE/lib/ports.mjs" get --workspace "$WORKSPACE" 2>/dev/null || true)"
if [ -n "${PORT:-}" ]; then
  for pid in $(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null || true); do
    CWD="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
    case "${CWD:-}" in
      "$WORKSPACE"*) kill_tree "$pid"; note "stopped listener on port $PORT (pid $pid)" ;;
      *) note "port $PORT is used by a process outside this workspace — left alone" ;;
    esac
  done
fi

# ----------------------------------------------------------------- port
step "Releasing the port reservation"
node "$HERE/lib/ports.mjs" release --workspace "$WORKSPACE" 2>/dev/null || true

printf '\n\033[1m✓ Teardown complete\033[0m\n'
