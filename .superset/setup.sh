#!/usr/bin/env bash
#
# Superset workspace setup for sndmail.
#
# Runs inside a freshly created workspace (a git worktree) and makes it ready:
#   1. installs npm dependencies
#   2. copies untracked/ignored files (secrets, local config) from the main checkout
#   3. reserves a free dev-server port for this workspace
#
# Environment (provided by Superset):
#   SUPERSET_ROOT_PATH      path of the main repository checkout
#   SUPERSET_WORKSPACE_PATH path of this workspace's worktree
#   SUPERSET_WORKSPACE_NAME name of this workspace
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

step() { printf '\n\033[1m→ %s\033[0m\n' "$1"; }
note() { printf '   %s\n' "$1"; }

# --------------------------------------------------------------- locations
ROOT="${SUPERSET_ROOT_PATH:-}"
if [ -z "$ROOT" ] || [ ! -f "$ROOT/package.json" ]; then
  ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
fi

# The workspace is the worktree this script runs in. Superset runs the scripts
# in the workspace directory, so the current directory wins; SUPERSET_WORKSPACE_PATH
# is the fallback. Neither is trusted blindly (a stale env var must not point the
# setup at another worktree).
WORKSPACE=""
for candidate in "$PWD" "${SUPERSET_WORKSPACE_PATH:-}"; do
  if [ -n "$candidate" ] &&
     [ -f "$candidate/package.json" ] &&
     [ -d "$candidate/.superset" ] &&
     [ "$candidate" != "$ROOT" ]; then
    WORKSPACE="$candidate"
    break
  fi
done
[ -n "$WORKSPACE" ] || WORKSPACE="$PWD"
NAME="${SUPERSET_WORKSPACE_NAME:-$(basename "$WORKSPACE")}"

cd "$WORKSPACE"

# ---------------------------------------------------------------- dependencies
step "Installing npm dependencies"
if [ -f package-lock.json ]; then
  npm ci --no-audit --no-fund
else
  npm install --no-audit --no-fund
fi

# --------------------------------------------------------------- untracked files
step "Copying untracked files from the main checkout"
# The main checkout holds the files that are deliberately not in git: .env files,
# signing keys, local tooling config. Every workspace needs them, git cannot
# provide them, so they are copied here (never committed).
COPY_LIST="$HERE/copy-files.txt"
copied=0

copy_one() {
  local rel="$1"
  local src="$ROOT/$rel"
  [ -f "$src" ] || return 0
  local dest="$WORKSPACE/$rel"
  mkdir -p "$(dirname "$dest")"
  cp -p "$src" "$dest"
  note "copied $rel"
  copied=$((copied + 1))
}

if [ -e "$ROOT/.git" ]; then
  while IFS= read -r -d '' rel; do
    case "$rel" in
      node_modules/* | */node_modules/*) continue ;;
      .git/* | .superset/* | */.superset/*) continue ;;
      dist/* | */dist/* | build/* | */build/*) continue ;;
      target/* | */target/*) continue ;;
      src-tauri/binaries/*) continue ;;
      .next/* | coverage/*) continue ;;
      *.log | *.db | *.db-shm | *.db-wal | *.sqlite | *.sqlite3) continue ;;
      .DS_Store | *.swp | *~) continue ;;
      *) copy_one "$rel" ;;
    esac
  done < <(
    git -C "$ROOT" ls-files --others --exclude-standard -z 2>/dev/null || true
    git -C "$ROOT" ls-files --others --ignored --exclude-standard -z 2>/dev/null || true
  )
fi

# extra paths can be listed in .superset/copy-files.txt (one relative path per line)
if [ -f "$COPY_LIST" ]; then
  while IFS= read -r rel; do
    rel="${rel%%#*}"
    rel="$(printf '%s' "$rel" | tr -d '[:space:]')"
    [ -n "$rel" ] || continue
    copy_one "$rel"
  done < "$COPY_LIST"
fi

if [ "$copied" -eq 0 ]; then
  note "nothing to copy (no untracked files in $ROOT)"
else
  note "$copied file(s) copied"
fi

# -------------------------------------------------------------------- port
step "Reserving a dev-server port for this workspace"
PORT="$(node "$HERE/lib/ports.mjs" reserve --workspace "$WORKSPACE" --name "$NAME")"
note "workspace port: $PORT (http://localhost:$PORT)"

printf '\n\033[1m✓ Workspace ready\033[0m — start the dev server with the Run button or: ./.superset/run.sh\n'
